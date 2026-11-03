import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { MongoMemoryServer } from 'mongodb-memory-server';
process.env.NODE_ENV = 'test';
process.env.SECURITY_OTP_SINK = 'true';
process.env.JWT_SECRET = 'trusted-device-test-only-independent-authentication-key';
const { default: app } = await import('../src/app.js');
const { StaffUser } = await import('../src/models/StaffUser.model.js');
const { SystemConfig } = await import('../src/models/SystemConfig.model.js');
const { TrustedStaffDevice } = await import('../src/models/TrustedStaffDevice.model.js');
const { AccessSession } = await import('../src/models/AccessSession.model.js');
const { AuditLog } = await import('../src/models/AuditLog.model.js');
const { otpSink, digest, createSession } = await import('../src/services/accessSessionService.js');
const { RateLimitBucket } = await import('../src/middlewares/rateLimiter.js');
const { STAFF_VERIFICATION_KEY: key } = await import('../src/services/staffVerificationPolicy.js');
let db, server, base, hash, sequence = 0;
before(async () => {
  db = await MongoMemoryServer.create(); await mongoose.connect(db.getUri());
  hash = await bcrypt.hash('TestPassword!123', 10);
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => { await SystemConfig.deleteMany({}); await RateLimitBucket.deleteMany({}); await TrustedStaffDevice.deleteMany({}); });
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await db.stop(); });
const person = (role = 'admin') => StaffUser.create({ name: 'Device Test', email: `device-${++sequence}@example.test`, phone: '0712000001', role, passwordHash: hash });
async function call(path, body, { cookie, csrf, method = body ? 'POST' : 'GET' } = {}) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5177', ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json().catch(() => ({})), cookies: response.headers.getSetCookie() };
}
const cookie = (result, name) => result.cookies.find(value => value.startsWith(`${name}=`))?.split(';')[0];
const login = (user, device, password = 'TestPassword!123') => call('/api/staff/login', { email: user.email, password }, { cookie: device });
async function verify(user) {
  const start = await login(user); assert.equal(start.data.otpRequired, true);
  const code = otpSink.get(digest(start.data.challengeId)).code;
  const result = await call('/api/staff/otp/verify', { challengeId: start.data.challengeId, code });
  assert.equal(result.status, 200);
  return result;
}
async function session(user, age = 0) {
  const token = await createSession('staff', user, { verifiedAt: new Date(Date.now() - age) });
  return { cookie: `tinzel_staff=${token}`, csrf: (await AccessSession.findById(digest(token))).csrf };
}
const setInterval = value => SystemConfig.findOneAndUpdate({ key }, { value }, { upsert: true });
for (const role of ['admin', 'manager']) test(`${role} verifies once on a browser and can sign out and sign in without another SMS`, async () => {
  const user = await person(role), verified = await verify(user);
  const device = cookie(verified, 'tinzel_staff_device');
  assert.ok(device);
  const header = verified.cookies.find(value => value.startsWith('tinzel_staff_device='));
  assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Strict/); assert.match(header, /Max-Age=604800/);
  const stored = await TrustedStaffDevice.findOne({ subjectId: String(user._id) });
  assert.notEqual(stored._id, device.split('=')[1]);
  assert.equal((await call('/api/staff/logout', {}, { cookie: cookie(verified, 'tinzel_staff'), csrf: verified.data.csrf })).status, 200);
  const repeat = await login(user, device);
  assert.equal(repeat.status, 200); assert.equal(repeat.data.otpRequired, undefined); assert.equal(repeat.data.token, 'cookie');
  assert.equal(repeat.cookies.some(value => value.startsWith('tinzel_staff_device=')), false);
  assert.equal((await call('/api/staff/me', null, { cookie: cookie(repeat, 'tinzel_staff') })).status, 200);
  assert.equal((await login(user, device, 'WrongPassword')).status, 401);
  await RateLimitBucket.deleteMany({});
  assert.equal((await login(user)).data.otpRequired, true);
});
test('shorter policy, expired trust, and every-login policy require another SMS', async () => {
  const user = await person(), verified = await verify(user), device = cookie(verified, 'tinzel_staff_device');
  await TrustedStaffDevice.updateMany({ subjectId: String(user._id) }, { verifiedAt: new Date(Date.now() - 2 * 3600000) });
  await setInterval(1); await RateLimitBucket.deleteMany({});
  assert.equal((await login(user, device)).data.otpRequired, true);
  await setInterval(168); await TrustedStaffDevice.updateMany({}, { expiresAt: new Date(0) }); await RateLimitBucket.deleteMany({});
  assert.equal((await login(user, device)).data.otpRequired, true);
  await setInterval(0); await RateLimitBucket.deleteMany({});
  const fresh = await verify(user);
  assert.match(fresh.cookies.find(value => value.startsWith('tinzel_staff_device=')), /Max-Age=0/);
  await RateLimitBucket.deleteMany({});
  assert.equal((await login(user, device)).data.otpRequired, true);
});
test('trust is bound to account, role, credentials and contact; it cannot replace a session', async () => {
  const user = await person(), other = await person(), verified = await verify(user), device = cookie(verified, 'tinzel_staff_device');
  assert.equal((await call('/api/staff/me', null, { cookie: device })).status, 401);
  assert.equal((await login(other, device)).data.otpRequired, true);
  for (const change of [{ tokenVersion: 1 }, { role: 'manager' }, { phone: '0712000002' }]) {
    await StaffUser.updateOne({ _id: user._id }, { $set: { tokenVersion: 0, role: 'admin', phone: '0712000001', ...change } });
    await RateLimitBucket.deleteMany({});
    assert.equal((await login(user, device)).data.otpRequired, true);
  }
  await StaffUser.updateOne({ _id: user._id }, { isActive: false });
  assert.equal((await login(user, device)).status, 403);
});
test('trust preserves the actual SMS time, so sensitive actions require recent verification', async () => {
  const user = await person(), verified = await verify(user), device = cookie(verified, 'tinzel_staff_device');
  const original = new Date(Date.now() - 3600000);
  await TrustedStaffDevice.updateMany({}, { verifiedAt: original });
  const repeat = await login(user, device);
  const token = cookie(repeat, 'tinzel_staff').split('=')[1];
  assert.equal(+(await AccessSession.findById(digest(token))).verifiedAt, +original);
  const result = await call('/api/admin/config', { key, value: 24 }, { method: 'PUT', cookie: cookie(repeat, 'tinzel_staff'), csrf: repeat.data.csrf });
  assert.equal(result.status, 403); assert.equal(result.data.errorCode, 'OTP_REQUIRED');
});
test('only recently verified admins can save supported intervals; changes persist and are audited', async () => {
  const admin = await person(), auth = await session(admin);
  const defaults = await call('/api/admin/config', null, auth);
  assert.equal(defaults.data.configs.find(config => config.key === key).value, 168);
  for (const value of [-1, 721, 1.5, '24', null, true]) assert.equal((await call('/api/admin/config', { key, value }, { ...auth, method: 'PUT' })).status, 400);
  for (const role of ['manager', 'designer']) {
    const other = await session(await person(role));
    assert.equal((await call('/api/admin/config', { key, value: 24 }, { ...other, method: 'PUT' })).status, 403);
  }
  const saved = await call('/api/admin/config', { key, value: 24 }, { ...auth, method: 'PUT' });
  assert.equal(saved.status, 200); assert.equal(saved.data.config.value, 24);
  assert.equal((await SystemConfig.findOne({ key })).value, 24);
  assert.equal(await AuditLog.countDocuments({ action: 'SYSTEM_CONFIG_UPDATED', 'details.key': key, 'details.newValue': 24 }), 1);
  await verify(await person());
  assert.equal(await TrustedStaffDevice.countDocuments(), 1);
  assert.equal((await call('/api/admin/config', { key, value: 0 }, { ...auth, method: 'PUT' })).status, 200);
  assert.equal(await TrustedStaffDevice.countDocuments(), 0);
});
