import { createHash } from 'node:crypto';
import { consumeRateLimit } from '../middlewares/rateLimiter.js';
const failure = (status, message) => Object.assign(new Error(message), { status });
export const normalizedEmail = value => typeof value === 'string' ? value.trim().toLowerCase().slice(0, 254) : '';
export const privateKey = value => createHash('sha256').update(String(value)).digest('hex');
export function captchaConfig() {
  const enabled = process.env.NODE_ENV === 'production' || Boolean(process.env.TURNSTILE_SECRET_KEY);
  return { enabled, siteKey: enabled ? process.env.TURNSTILE_SITE_KEY || '' : '' };
}
export async function verifyCaptchaToken(token, action, { fetcher = fetch } = {}) {
  if (!captchaConfig().enabled) return;
  const secret = process.env.TURNSTILE_SECRET_KEY;
  const hostnames = (process.env.TURNSTILE_HOSTNAMES || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!secret || !process.env.TURNSTILE_SITE_KEY || !hostnames.length) throw failure(503, 'Security verification is unavailable. Please try again later.');
  if (typeof token !== 'string' || !token || token.length > 2048) throw failure(400, 'Complete the security check and try again.');
  let result;
  try {
    const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token }), signal: AbortSignal.timeout(8000), redirect: 'error',
    });
    if (!response.ok) throw new Error();
    result = await response.json();
  } catch { throw failure(503, 'Security verification is unavailable. Please try again later.'); }
  if (result.success !== true || result.action !== action || !hostnames.includes(result.hostname)) throw failure(400, 'Complete the security check and try again.');
}
export const captcha = action => async (req, res, next) => {
  try { await verifyCaptchaToken(req.body?.captchaToken, action); next(); } catch (error) { next(error); }
};
export function authLimits(scope, { account = true, maxAccount = 10, maxIp = 50, windowMs = 900000 } = {}) {
  return async (req, res, next) => {
    try {
      for (const [suffix, key, maxAttempts] of [
        ['ip', req.ip, maxIp], ...(account ? [['account', privateKey(normalizedEmail(req.body?.email)), maxAccount]] : []),
      ]) {
        const result = await consumeRateLimit({ scope: `auth-${scope}-${suffix}`, key, maxAttempts, windowMs, failClosed: true });
        if (!result.allowed) { res.set('Retry-After', String(result.retryAfterSeconds)); return res.status(429).json({ message: 'Too many attempts. Please wait before trying again.', retryAfterSeconds: result.retryAfterSeconds }); }
      }
      next();
    } catch (error) { next(error); }
  };
}
// Only a five-character SHA-1 prefix leaves the server; passwords and full hashes never do.
export async function assertUncompromisedPassword(password, { fetcher = fetch } = {}) {
  if (process.env.NODE_ENV === 'test' && process.env.PASSWORD_BREACH_CHECK !== 'true') return;
  const hash = createHash('sha1').update(password).digest('hex').toUpperCase();
  let body;
  try {
    const response = await fetcher(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'Tinzel-Password-Security' }, signal: AbortSignal.timeout(8000), redirect: 'error',
    });
    if (!response.ok) throw new Error();
    body = await response.text();
    if (!/^[A-F0-9]{35}:\d+/m.test(body)) throw new Error();
  } catch { throw failure(503, 'Password safety check is unavailable. Please try again later.'); }
  if (body.split(/\r?\n/).some(line => { const [suffix, count] = line.split(':'); return suffix === hash.slice(5) && Number(count) > 0; })) {
    throw failure(400, 'This password has appeared in a data breach. Choose a different passphrase.');
  }
}
