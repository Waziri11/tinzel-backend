import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { MongoMemoryServer } from 'mongodb-memory-server';
process.env.NODE_ENV = 'test'; process.env.SECURITY_OTP_SINK = 'true';
process.env.JWT_SECRET = 'auth-enhancements-disposable-test-secret-only';
const { default: app } = await import('../src/app.js');
const { StaffUser } = await import('../src/models/StaffUser.model.js');
const { AccessSession, AccessChallenge } = await import('../src/models/AccessSession.model.js');
const { TrustedStaffDevice } = await import('../src/models/TrustedStaffDevice.model.js');
const { SecurityEvent } = await import('../src/models/SecurityEvent.model.js');
const { Notification } = await import('../src/models/Notification.model.js');
const { AuditLog } = await import('../src/models/AuditLog.model.js');
const { RateLimitBucket } = await import('../src/middlewares/rateLimiter.js');
const { otpSink, digest, createSession, contactFingerprint } = await import('../src/services/accessSessionService.js');
const { pendingRecoveries } = await import('../src/routes/staffSecurity.routes.js');
const { runAuthAlerts } = await import('../src/services/authActivityService.js');
let mongo, server, base, hash, sequence = 0;
const password = 'Existing sunflower river!7', replacement = 'Fresh copper meadow harbor!9';
before(async () => {
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  await Promise.all([StaffUser.init(), Notification.init(), SecurityEvent.init()]); hash = await bcrypt.hash(password, 10);
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}/api/staff`;
});
beforeEach(async () => { await Promise.all([...pendingRecoveries]); await RateLimitBucket.deleteMany({}); });
after(async () => { await Promise.all([...pendingRecoveries]); server.closeAllConnections(); await new Promise(r => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });
const person = (role = 'designer', extra = {}) => StaffUser.create({ name: 'Auth fixture', email: `auth-${++sequence}@example.test`, role, phone: '0712000033', preferredLanguage: 'en', passwordHash: hash, ...extra });
async function call(path, body, options = {}) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5177', ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.csrf ? { 'X-CSRF-Token': options.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json().catch(() => ({})), cookies: response.headers.getSetCookie(), retry: response.headers.get('retry-after') };
}
const cookie = (result, key = 'tinzel_staff') => result.cookies.find(s => s.startsWith(key + '='))?.split(';')[0];
async function session(user, verified = true) { const token = await createSession('staff', user, { verifiedAt: verified ? new Date() : undefined }); return { cookie: `tinzel_staff=${token}`, csrf: (await AccessSession.findById(digest(token))).csrf, id: digest(token) }; }
async function recover(user) {
  const result = await call('/recovery/request', { email: user.email }); assert.equal(result.status, 200); await Promise.all([...pendingRecoveries]);
  const entry = otpSink.get(digest(result.data.challengeId)); assert.ok(entry); return { ...result.data, code: entry.code };
}
async function grant(user) { const challenge = await recover(user); const result = await call('/recovery/verify', { challengeId: challenge.challengeId, code: challenge.code }); assert.equal(result.status, 200); return result.data.resetToken; }
test('recovery hides eligibility and never delivers to unknown or disabled accounts', async () => {
  const active = await person(), disabled = await person('designer', { isActive: false });
  for (const email of [active.email, disabled.email, 'missing@example.test']) {
    const result = await call('/recovery/request', { email }); assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.data).sort(), ['success', 'challengeId', 'expiresIn', 'resendAfter', 'message'].sort());
    assert.match(result.data.challengeId, /^[a-f0-9]{64}$/); await Promise.all([...pendingRecoveries]);
    assert.equal(otpSink.has(digest(result.data.challengeId)), email === active.email);
    assert.equal(result.data.message, 'If an eligible account exists, a verification code will be sent to its registered phone.');
  }
});
test('recovery is single-use, purpose-bound, revokes old access, and never creates a login session', async () => {
  const user = await person('manager'), previous = await session(user);
  await TrustedStaffDevice.create({ _id: 'a'.repeat(64), subjectId: String(user._id), role: user.role, tokenVersion: 0, contactFingerprint: contactFingerprint(user), verifiedAt: new Date(), expiresAt: new Date(Date.now() + 100000) });
  const challenge = await recover(user);
  assert.equal((await call('/otp/verify', { challengeId: challenge.challengeId, code: challenge.code })).status, 401);
  const verified = await call('/recovery/verify', { challengeId: challenge.challengeId, code: challenge.code }); assert.equal(verified.status, 200); assert.equal(verified.cookies.length, 0);
  assert.equal((await call('/recovery/verify', { challengeId: challenge.challengeId, code: challenge.code })).status, 401);
  const reset = await call('/recovery/reset', { resetToken: verified.data.resetToken, newPassword: replacement }); assert.equal(reset.status, 200);
  assert.ok(reset.cookies.every(c => /Max-Age=0/.test(c)));
  assert.equal((await StaffUser.findById(user._id)).tokenVersion, 1); assert.equal(await AccessSession.countDocuments({ subjectId: String(user._id) }), 0);
  assert.equal(await TrustedStaffDevice.countDocuments({ subjectId: String(user._id) }), 0);
  assert.equal((await call('/me', null, previous)).status, 401);
  assert.equal((await call('/recovery/reset', { resetToken: verified.data.resetToken, newPassword: replacement })).status, 401);
  assert.equal((await call('/login', { email: user.email, password: replacement })).data.otpRequired, true);
  const notifications = await Notification.find({ recipientUser: user._id, 'metadata.action': 'AUTH_PASSWORD_RESET' }); assert.equal(notifications.length, 3);
  const events = await SecurityEvent.find({ actorId: String(user._id) }).lean(); const logged = JSON.stringify(events);
  for (const secret of [password, replacement, challenge.code, challenge.challengeId, verified.data.resetToken]) assert.ok(!logged.includes(secret));
});
test('five incorrect guesses exhaust a code; expiry and resends invalidate old codes', async () => {
  const user = await person(), c = await recover(user);
  for (let n = 0; n < 5; n++) assert.equal((await call('/recovery/verify', { challengeId: c.challengeId, code: '000000' })).status, 401);
  assert.equal((await call('/recovery/verify', { challengeId: c.challengeId, code: c.code })).status, 401);
  await RateLimitBucket.deleteMany({}); const next = await recover(user); await AccessChallenge.updateOne({ _id: digest(next.challengeId) }, { expiresAt: new Date(0) });
  assert.equal((await call('/recovery/verify', { challengeId: next.challengeId, code: next.code })).status, 401);
  await RateLimitBucket.deleteMany({}); const older = await recover(user); await RateLimitBucket.deleteMany({}); await recover(user);
  assert.equal((await call('/recovery/verify', { challengeId: older.challengeId, code: older.code })).status, 401);
});
test('password reset rejects stale account/contact state, deactivation, expired grants and concurrent replay', async () => {
  for (const change of [{ tokenVersion: 1 }, { role: 'admin' }, { phone: '0712000044' }, { isActive: false }, { deletedAt: new Date() }]) {
    await RateLimitBucket.deleteMany({}); const user = await person(), token = await grant(user); await StaffUser.updateOne({ _id: user._id }, change);
    assert.equal((await call('/recovery/reset', { resetToken: token, newPassword: replacement })).status, 401);
  }
  await RateLimitBucket.deleteMany({}); const user = await person(), token = await grant(user);
  const results = await Promise.all([1, 2].map(() => call('/recovery/reset', { resetToken: token, newPassword: replacement })));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  await RateLimitBucket.deleteMany({}); const expired = await grant(await person()); await AccessChallenge.updateOne({ _id: digest(expired) }, { expiresAt: new Date(0) });
  assert.equal((await call('/recovery/reset', { resetToken: expired, newPassword: replacement })).status, 401);
});
test('weak password rejection keeps recovery grant usable and expired initial credentials can be recovered', async () => {
  const user = await person('designer', { mustChangePassword: true, temporaryPasswordExpiresAt: new Date(0) }), token = await grant(user);
  assert.equal((await call('/recovery/reset', { resetToken: token, newPassword: 'Cedar!7' })).status, 400);
  assert.equal((await call('/recovery/reset', { resetToken: token, newPassword: 'Cedar!72' })).status, 200);
  const updated = await StaffUser.findById(user._id); assert.equal(updated.mustChangePassword, false); assert.equal(updated.temporaryPasswordExpiresAt, null);
});
test('session inventory is private; revocation enforces ownership, CSRF, and recent SMS verification', async () => {
  const user = await person(), other = await person(), auth = await session(user), otherAuth = await session(other), stale = await session(user, false);
  assert.equal((await call('/security', null)).status, 401);
  const inventory = await call('/security', null, auth); assert.equal(inventory.status, 200); assert.equal(inventory.data.sessions.length, 2);
  assert.ok(inventory.data.sessions.every(s => !('csrf' in s) && !('subjectId' in s))); assert.ok(inventory.data.sessions.some(s => s.current));
  assert.equal((await call('/security/revoke', { kind: 'session', id: otherAuth.id }, auth)).status, 404);
  assert.equal((await call('/security/revoke', { kind: 'session', id: auth.id }, { cookie: auth.cookie })).status, 403);
  assert.equal((await call('/security/revoke-all', {}, stale)).status, 403);
  assert.equal((await call('/security/revoke', { kind: 'session', id: stale.id }, auth)).status, 200);
  assert.equal((await call('/me', null, stale)).status, 401);
  assert.equal((await call('/security/revoke-all', {}, auth)).status, 200);
  assert.equal((await call('/me', null, otherAuth)).status, 200);
});
test('trust is opt-in; new-browser alerts are recognized separately from OTP trust', async () => {
  const user = await person('manager');
  async function login(trustDevice) { const start = await call('/login', { email: user.email, password }); const code = otpSink.get(digest(start.data.challengeId)).code; return call('/otp/verify', { challengeId: start.data.challengeId, code, trustDevice }); }
  const first = await login(false); assert.equal(first.status, 200); assert.equal(await TrustedStaffDevice.countDocuments({ subjectId: String(user._id) }), 0);
  assert.ok(first.cookies.some(c => c.startsWith('tinzel_staff_device=;')));
  await RateLimitBucket.deleteMany({}); const trusted = await login(true); assert.equal(trusted.status, 200); assert.equal(await TrustedStaffDevice.countDocuments({ subjectId: String(user._id) }), 1);
  const alertCount = await Notification.countDocuments({ recipientUser: user._id, 'metadata.action': 'AUTH_NEW_DEVICE' });
  const repeat = await call('/login', { email: user.email, password }, { cookie: [cookie(trusted, 'tinzel_staff_device'), cookie(trusted, 'tinzel_staff_known')].join('; ') });
  assert.equal(repeat.status, 200); assert.equal(repeat.data.otpRequired, undefined); assert.equal(await Notification.countDocuments({ recipientUser: user._id, 'metadata.action': 'AUTH_NEW_DEVICE' }), alertCount);
});
test('normal logout revokes only its session; sign-out-everywhere invalidates trust and challenges', async () => {
  const user = await person(), first = await session(user), second = await session(user);
  assert.equal((await call('/logout', {}, first)).status, 200); assert.equal((await call('/me', null, second)).status, 200);
  const challenge = await recover(user); await call('/security/revoke-all', {}, second);
  assert.equal((await call('/recovery/verify', { challengeId: challenge.challengeId, code: challenge.code })).status, 401);
});
test('assisted recovery requires a verified admin, evidence, a target-phone OTP, and preserves role/account status', async () => {
  const admin = await person('admin'), user = await person('manager'), auth = await session(admin), body = { email: user.email, phone: '0712000055', evidence: 'In-person staff identity verification; case TEST-42', identityConfirmed: true };
  assert.equal((await call('/security/assisted-recovery', body, await session(user))).status, 403);
  assert.equal((await call('/security/assisted-recovery', body, await session(admin, false))).status, 403);
  assert.equal((await call('/security/assisted-recovery', { ...body, identityConfirmed: false }, auth)).status, 400);
  assert.equal((await call('/security/assisted-recovery', { ...body, email: admin.email }, auth)).status, 400);
  const started = await call('/security/assisted-recovery', body, auth); assert.equal(started.status, 200);
  const code = otpSink.get(digest(started.data.challengeId)).code; assert.equal((await StaffUser.findById(user._id)).phone, user.phone);
  const old = await session(user);
  const verified = await call('/security/assisted-recovery/verify', { challengeId: started.data.challengeId, code }, auth); assert.equal(verified.status, 200);
  const updated = await StaffUser.findById(user._id); assert.equal(updated.phone, '+255712000055'); assert.equal(updated.role, 'manager'); assert.equal(updated.isActive, true);
  assert.equal((await call('/me', null, old)).status, 401);
  assert.equal(await AuditLog.countDocuments({ action: 'AUTH_ASSISTED_RECOVERY_COMPLETED', 'details.staffId': String(user._id) }), 1);
  assert.equal(await Notification.countDocuments({ recipientUser: user._id, 'metadata.action': 'AUTH_ASSISTED_RECOVERY' }), 4);
});
test('independent account and IP limits prevent distributed guesses and SMS floods', async () => {
  const user = await person();
  await RateLimitBucket.create({ _id: `auth-login-account:${digest(user.email)}`, count: 10, expiresAt: new Date(Date.now() + 900000) });
  const limited = await call('/login', { email: user.email, password }); assert.equal(limited.status, 429); assert.ok(Number(limited.retry) > 0);
  await RateLimitBucket.deleteMany({});
  for (let n = 0; n < 5; n++) assert.equal((await call('/recovery/request', { email: user.email })).status, 200);
  assert.equal((await call('/recovery/request', { email: user.email })).status, 429);
  await Promise.all([...pendingRecoveries]); assert.equal(await AccessChallenge.countDocuments({ subjectId: String(user._id), purpose: 'recovery' }), 1);
});
test('security alert worker claims messages once and does not retry unknown delivery outcomes', async () => {
  await Notification.updateMany({ 'metadata.authAlert': true }, { status: 'sent' });
  const row = await Notification.create({ recipient: '0712000033', channel: 'sms', message: 'Synthetic security alert', status: 'queued', metadata: { authAlert: true } });
  let sent = 0; const send = async () => { sent++; throw new Error('Uncertain provider acceptance'); };
  await Promise.all([runAuthAlerts({ send }), runAuthAlerts({ send })]); assert.equal(sent, 1);
  assert.equal((await Notification.findById(row._id)).status, 'unconfirmed'); await runAuthAlerts({ send }); assert.equal(sent, 1);
});

test('production routes reject missing CAPTCHA configuration before login or recovery delivery', async () => {
  const previous = process.env.NODE_ENV, secret = process.env.TURNSTILE_SECRET_KEY, frontend = process.env.FRONTEND_URL;
  try {
    process.env.NODE_ENV = 'production'; delete process.env.TURNSTILE_SECRET_KEY;
    process.env.FRONTEND_URL = 'http://127.0.0.1:5177';
    const user = await person();
    assert.equal((await call('/login', { email: user.email, password })).status, 503);
    assert.equal((await call('/recovery/request', { email: user.email })).status, 503);
    assert.equal(await AccessChallenge.countDocuments({ subjectId: String(user._id) }), 0);
    assert.equal(await AccessSession.countDocuments({ subjectId: String(user._id) }), 0);
  } finally { process.env.NODE_ENV = previous; if (secret === undefined) delete process.env.TURNSTILE_SECRET_KEY; else process.env.TURNSTILE_SECRET_KEY = secret; if (frontend === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = frontend; }
});
