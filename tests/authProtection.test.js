import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyCaptchaToken, captchaConfig, assertUncompromisedPassword } from '../src/services/authProtectionService.js';
import { passwordErrors } from '../src/services/staffCredentialService.js';
const preserve = keys => { const previous = Object.fromEntries(keys.map(k => [k, process.env[k]])); return () => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }; };
test('production CAPTCHA fails closed without keys; validates action and hostname as well as success', async () => {
  const restore = preserve(['NODE_ENV', 'TURNSTILE_SECRET_KEY', 'TURNSTILE_SITE_KEY', 'TURNSTILE_HOSTNAMES']);
  try {
    process.env.NODE_ENV = 'production'; delete process.env.TURNSTILE_SECRET_KEY;
    assert.equal(captchaConfig().enabled, true); await assert.rejects(verifyCaptchaToken('token', 'login'), e => e.status === 503);
    process.env.TURNSTILE_SECRET_KEY = 'synthetic-secret'; process.env.TURNSTILE_SITE_KEY = 'synthetic-public-key'; process.env.TURNSTILE_HOSTNAMES = 'tinzel.example.test';
    await assert.rejects(verifyCaptchaToken('', 'login'), e => e.status === 400);
    for (const result of [{ success: false }, { success: true, action: 'recovery', hostname: 'tinzel.example.test' }, { success: true, action: 'login', hostname: 'attacker.example' }]) {
      await assert.rejects(verifyCaptchaToken('token', 'login', { fetcher: async () => ({ ok: true, json: async () => result }) }), e => e.status === 400);
    }
    let calls = 0;
    const fetcher = async (url, options) => { calls++; assert.equal(new URL(url).hostname, 'challenges.cloudflare.com'); assert.equal(JSON.parse(options.body).secret, 'synthetic-secret'); return { ok: true, json: async () => calls === 1 ? { success: true, action: 'login', hostname: 'tinzel.example.test' } : { success: false, 'error-codes': ['timeout-or-duplicate'] } }; };
    await verifyCaptchaToken('single-use-token', 'login', { fetcher }); await assert.rejects(verifyCaptchaToken('single-use-token', 'login', { fetcher }), e => e.status === 400);
    await assert.rejects(verifyCaptchaToken('token', 'login', { fetcher: async () => { throw new Error('outage'); } }), e => e.status === 503);
    assert.ok(!JSON.stringify(captchaConfig()).includes('synthetic-secret'));
  } finally { restore(); }
});
test('password checks accept long phrases, reject common/oversize values and send only a padded hash-prefix query', async () => {
  const restore = preserve(['NODE_ENV', 'PASSWORD_BREACH_CHECK']);
  try {
    process.env.NODE_ENV = 'test'; process.env.PASSWORD_BREACH_CHECK = 'true';
    const phrase = 'meadow copper river lantern'; const hash = createHash('sha1').update(phrase).digest('hex').toUpperCase();
    assert.deepEqual(passwordErrors(phrase), []); assert.ok(passwordErrors('password123456789').length); assert.ok(passwordErrors('x'.repeat(80)).length); assert.ok(passwordErrors('🙂'.repeat(19)).length);
    const fetcher = async (url, options) => { assert.equal(url, `https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`); assert.equal(options.headers['Add-Padding'], 'true'); assert.ok(!JSON.stringify(options).includes(phrase)); return { ok: true, text: async () => `${hash.slice(5)}:12\r\n${'A'.repeat(35)}:0` }; };
    await assert.rejects(assertUncompromisedPassword(phrase, { fetcher }), e => e.status === 400);
    await assertUncompromisedPassword(phrase, { fetcher: async () => ({ ok: true, text: async () => `${hash.slice(5)}:0` }) });
    await assert.rejects(assertUncompromisedPassword(phrase, { fetcher: async () => { throw new Error('outage'); } }), e => e.status === 503);
  } finally { restore(); }
});
