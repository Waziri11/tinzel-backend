import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
process.env.NODE_ENV = 'test';
process.env.SECURITY_OTP_SINK = 'true';
process.env.JWT_SECRET = 'csrf-disposable-test-key-at-least-32-characters';
const { default: app } = await import('../src/app.js');
const { AccessSession } = await import('../src/models/AccessSession.model.js');
const { StaffUser } = await import('../src/models/StaffUser.model.js');
const { createSession, digest, readSession } = await import('../src/services/accessSessionService.js');
const { isAllowedOrigin } = await import('../src/services/csrfService.js');
let mongo, server, base, user;
before(async () => {
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  user = await StaffUser.create({ name: 'CSRF fixture', email: 'csrf@example.test', phone: '0712000002', role: 'designer', passwordHash: 'unused' });
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });
async function session(kind = 'staff') {
  const token = await createSession(kind, user);
  return { token, cookie: `tinzel_${kind}=${token}`, csrf: (await AccessSession.findById(digest(token))).csrf };
}
async function request(path, { method = 'GET', cookie, csrf, origin = 'http://127.0.0.1:5177', body, headers = {} } = {}) {
  const response = await fetch(base + path, { method, headers: { ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { response, data: await response.json().catch(() => ({})) };
}
test('bootstrap restores separate live session tokens, never caches, and rejects unauthenticated or foreign requests', async () => {
  const tokens = new Set();
  for (const kind of ['staff', 'client', 'printer']) {
    const s = await session(kind);
    const { response, data } = await request(`/api/csrf/${kind}`, s);
    assert.equal(response.status, 200); assert.equal(data.csrf, s.csrf); tokens.add(data.csrf);
    assert.match(response.headers.get('cache-control'), /no-store/); assert.match(response.headers.get('vary'), /Cookie/);
    assert.equal((await request(`/api/csrf/${kind}`, { ...s, origin: 'https://attacker.test' })).response.status, 403);
    assert.equal((await request(`/api/csrf/${kind}`, { ...s, origin: null, headers: { 'Sec-Fetch-Site': 'cross-site' } })).response.status, 403);
    assert.equal((await request(`/api/csrf/${kind}`)).response.status, 401);
  }
  assert.equal(tokens.size, 3);
  assert.equal((await request('/api/csrf/unknown')).response.status, 404);
});
test('missing, malformed, foreign-session tokens and missing/foreign origins fail before changing preferences or activity', async () => {
  const s = await session(), other = await session('client');
  const before = await AccessSession.findById(digest(s.token)).lean();
  for (const override of [{ csrf: undefined }, { csrf: 'bad' }, { csrf: '0'.repeat(48) }, { csrf: other.csrf }, { origin: null }, { origin: 'null' }, { origin: 'https://attacker.test' }]) {
    const { response, data } = await request('/api/staff/preferences', { ...s, ...override, method: 'PATCH', body: { preferredLanguage: 'en' } });
    assert.equal(response.status, 403); assert.match(data.errorCode, /^CSRF_/);
  }
  const after = await AccessSession.findById(digest(s.token)).lean();
  assert.equal(+before.idleUntil, +after.idleUntil); assert.equal(after.lastSeenAt, undefined);
  const result = await request('/api/staff/preferences', { ...s, method: 'PATCH', body: { preferredLanguage: 'en' } });
  assert.equal(result.response.status, 200);
  assert.equal((await StaffUser.findById(user._id)).preferredLanguage, 'en');
});
test('all unsafe methods and session kinds require the matching token; cookie takes precedence over bearer', async () => {
  for (const kind of ['staff', 'client', 'printer']) {
    const s = await session(kind);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const req = { method, headers: { cookie: s.cookie, authorization: `Bearer ${s.token}`, origin: 'http://localhost:5173' } };
      await assert.rejects(readSession(req, kind), e => e.code === 'CSRF_TOKEN_INVALID');
      req.headers['x-csrf-token'] = s.csrf;
      assert.equal((await readSession(req, kind)).csrf, s.csrf);
    }
    for (const method of ['GET', 'HEAD', 'OPTIONS']) assert.ok(await readSession({ method, headers: { cookie: s.cookie } }, kind));
    assert.ok(await readSession({ method: 'POST', headers: { authorization: `Bearer ${s.token}` } }, kind));
  }
});
test('logout revokes bootstrap access and a new session rejects the previous token', async () => {
  const old = await session(), fresh = await session();
  assert.notEqual(old.csrf, fresh.csrf);
  assert.equal((await request('/api/staff/logout', { ...old, method: 'POST' })).response.status, 200);
  assert.equal((await request('/api/csrf/staff', old)).response.status, 401);
  const rejected = await request('/api/staff/preferences', { ...fresh, csrf: old.csrf, method: 'PATCH', body: { preferredLanguage: 'sw' } });
  assert.equal(rejected.data.errorCode, 'CSRF_TOKEN_INVALID');
});
test('expired sessions cannot bootstrap and token-bearing profile responses are never cached', async () => {
  const s = await session();
  assert.match((await request('/api/staff/me', s)).response.headers.get('cache-control'), /no-store/);
  await AccessSession.updateOne({ _id: digest(s.token) }, { $set: { idleUntil: new Date(0) } });
  assert.equal((await request('/api/csrf/staff', s)).response.status, 401);
});
test('login, OTP and recovery reject foreign origins and simple form submissions before issuing credentials', async () => {
  for (const path of ['/api/staff/login', '/api/staff/otp/verify', '/api/staff/recovery/request', '/api/client/request-otp', '/api/client/verify-otp', '/api/printer/invitations/test/verify']) {
    const foreign = await request(path, { method: 'POST', origin: 'https://attacker.test', body: {} });
    assert.equal(foreign.response.status, 403); assert.equal(foreign.data.errorCode, 'CSRF_ORIGIN_INVALID');
    const form = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=attacker%40example.test' });
    assert.equal(form.status, 403);
  }
});
test('CORS and CSRF share trimmed configuration and only allow local development origins outside production', () => {
  const old = { env: process.env.NODE_ENV, origins: process.env.ALLOWED_ORIGINS, frontend: process.env.FRONTEND_URL };
  try {
    process.env.ALLOWED_ORIGINS = ' https://trusted.example.test , https://second.example.test ';
    process.env.FRONTEND_URL = ' https://frontend.example.test ';
    process.env.NODE_ENV = 'production';
    assert.ok(isAllowedOrigin('https://trusted.example.test')); assert.ok(isAllowedOrigin('https://frontend.example.test'));
    for (const origin of [undefined, 'null', 'https://trusted.example.test.attacker.test', 'http://localhost:5173']) assert.equal(isAllowedOrigin(origin), false);
    process.env.NODE_ENV = 'test'; assert.ok(isAllowedOrigin('http://127.0.0.1:5199'));
  } finally {
    for (const [key, value] of Object.entries({ NODE_ENV: old.env, ALLOWED_ORIGINS: old.origins, FRONTEND_URL: old.frontend })) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
