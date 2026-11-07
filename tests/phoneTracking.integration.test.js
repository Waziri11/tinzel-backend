import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { randomUUID, randomBytes } from 'node:crypto';
process.env.NODE_ENV = 'test';
process.env.SECURITY_OTP_SINK = 'true';
process.env.JWT_SECRET = 'phone-tracking-isolated-test-secret';
const { default: app } = await import('../src/app.js');
const { Order } = await import('../src/models/Order.model.js');
const { MagazineForm } = await import('../src/models/MagazineForm.model.js');
const { StaffUser } = await import('../src/models/StaffUser.model.js');
const { AccessSession, AccessChallenge } = await import('../src/models/AccessSession.model.js');
const { createSession, digest } = await import('../src/services/accessSessionService.js');
const { trackingLookupKey } = await import('../src/routes/clientTracking.routes.js');
let mongo, server, base, form, staff, staffToken, sequence = 0;
before(async () => {
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  await Order.init();
  form = await MagazineForm.create({ title: 'Phone test', slug: 'phone-test', isActive: true, price: 100, fields: [] });
  staff = await StaffUser.create({ name: 'Phone fixture', email: 'phone@example.test', phone: '0712 345 678', role: 'admin', passwordHash: 'unused' });
  staffToken = await createSession('staff', staff, { verifiedAt: new Date() });
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.closeAllConnections(); await new Promise(r => server ? server.close(r) : r()); await mongoose.disconnect(); await mongo?.stop(); });
async function call(path, body, { method = body ? 'POST' : 'GET', token, cookie, headers = {} } = {}) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5177', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: await res.json().catch(() => ({})), cookies: res.headers.getSetCookie().map(c => c.split(';')[0]) };
}
const order = (extra = {}) => Order.create({ submissionId: `SUB-PHONE-${++sequence}`, formId: form._id, clientName: 'Phone fixture', clientWhatsApp: '0712 345 678', ...extra });
const requestCode = (trackingId, clientWhatsApp = '+255712345678') => call('/api/client/request-otp', { trackingId, clientWhatsApp });

test('padded tracking IDs reach OTP and the same order, then restore only remembered access', async () => {
  const row = await order({ trackingId: 'TNZ-2026-0004' });
  const issued = await requestCode(' tnz-2026-00004 ', '0712 345 678');
  assert.equal(issued.status, 200); assert.match(issued.data.devOtp, /^\d{6}$/);
  const verified = await call('/api/client/verify-otp', { trackingId: 'TNZ-2026-4', otp: issued.data.devOtp });
  assert.equal(verified.status, 200);
  const details = await call('/api/client/order', null, { cookie: verified.cookies.join('; ') });
  assert.equal(details.data.order.trackingId, row.trackingId);
  const device = verified.cookies.find(c => c.startsWith('tinzel_tracking_'));
  assert.equal((await call('/api/client/request-otp', { trackingId: 'TNZ-2026-000004', resumeOnly: true }, { cookie: device })).data.clientToken, 'cookie');
  assert.equal((await call('/api/client/request-otp', { trackingId: 'TNZ-2026-000004', resumeOnly: true })).data.success, false);
  const session = await AccessSession.findOne({ kind: 'client', subjectId: String(row._id) }); assert.ok(session);
  await Order.updateOne({ _id: row._id }, { $set: { clientWhatsApp: '+255712345679' } });
  assert.equal((await call('/api/client/order', null, { cookie: verified.cookies.join('; ') })).status, 401);
  assert.equal((await call('/api/client/request-otp', { trackingId: row.trackingId, resumeOnly: true }, { cookie: device })).data.success, false);
});

test('exact IDs win, ambiguous aliases fail, and submission IDs are never padded', async () => {
  await order({ trackingId: 'TNZ-2026-0005' });
  await order({ trackingId: 'TNZ-2026-00005', clientWhatsApp: '+255712345679' });
  assert.equal((await requestCode('TNZ-2026-00005')).status, 401);
  assert.equal((await requestCode('TNZ-2026-00005', '0712345679')).status, 200);
  assert.equal((await requestCode('TNZ-2026-5')).status, 401);
  const row = await order({ submissionId: 'SUB-2026-0007' });
  assert.equal((await requestCode(row.submissionId)).status, 200);
  assert.equal((await requestCode('SUB-2026-7')).status, 401);
  const missing = await requestCode('TNZ-2026-9999'), wrong = await requestCode(row.submissionId, '0712345679');
  assert.equal(missing.status, 401); assert.equal(wrong.data.message, missing.data.message);
  assert.equal(trackingLookupKey('TNZ-2026-0004'), trackingLookupKey(' tnz-2026-4 '));
});

test('legacy formats compare consistently; foreign phones are preserved but unsupported verification cannot issue OTP', async () => {
  for (const phone of ['0712345680', '712345680', '255712345680', '+255 712 345 680', '00255712345680']) {
    const row = await order({ clientWhatsApp: phone });
    assert.equal((await requestCode(row.submissionId, '0712 345 680')).status, 200);
  }
  const foreign = await order({ clientWhatsApp: '+254712345678' });
  const result = await requestCode(foreign.submissionId, '00254 712 345 678');
  assert.equal(result.status, 400); assert.match(result.data.message, /only for Tanzanian/);
  assert.equal((await Order.findById(foreign._id)).otp?.code, undefined);
});

test('both submission transports persist canonical numbers and reject malformed ones', async () => {
  const direct = await call('/api/public/forms/phone-test/submit', { clientName: 'Direct fixture', clientWhatsApp: '0712 345 681', answers: {} });
  assert.equal(direct.status, 201, JSON.stringify(direct.data));
  assert.equal((await Order.findOne({ submissionId: direct.data.order.submissionId })).clientWhatsApp, '+255712345681');
  assert.equal((await call('/api/public/forms/phone-test/submit', { clientName: 'Invalid fixture', clientWhatsApp: 'bad' })).status, 400);
  const id = randomUUID(), token = randomBytes(32).toString('hex'), headers = { 'X-Upload-Token': token };
  assert.equal((await call('/api/public/media/sessions', { id, slug: form.slug }, { headers })).status, 201);
  const result = await call(`/api/public/media/sessions/${id}/submit`, { clientName: 'Upload fixture', clientWhatsApp: '00254 712 345 681', answers: {}, assetIds: [] }, { headers });
  assert.equal(result.status, 201, JSON.stringify(result.data)); assert.equal(result.data.order.clientWhatsApp, '+254712345681');
  assert.equal((await Order.findOne({ mediaSessionId: id })).clientWhatsApp, '+254712345681');
});

test('staff formatting changes keep sessions and stored contact bindings; real changes require verification', async () => {
  const profile = await call('/api/staff/profile', { name: staff.name, phone: '+255712345678' }, { method: 'PATCH', token: staffToken });
  assert.equal(profile.status, 200); assert.equal((await StaffUser.findById(staff._id)).phone, staff.phone);
  assert.equal((await call('/api/staff/me', null, { token: staffToken })).status, 200);
  assert.equal((await call('/api/staff/profile', { name: staff.name, phone: '+255712345679' }, { method: 'PATCH', token: staffToken })).status, 403);
  const changed = await call('/api/staff/contact', { channel: 'sms', destination: '+254712345678' }, { token: staffToken });
  assert.equal(changed.status, 400); assert.equal(await AccessChallenge.countDocuments({ subjectId: String(staff._id), purpose: 'contact' }), 0);
  const settings = await call('/api/admin/config', { key: 'printer_whatsapp_phone', value: '0712 345 682' }, { method: 'PUT', token: staffToken });
  assert.equal(settings.status, 200); assert.equal(settings.data.config.value, '+255712345682');
  const foreign = await call('/api/admin/config', { key: 'support_phone', value: '+254 712 345 682' }, { method: 'PUT', token: staffToken });
  assert.equal(foreign.data.config.value, '+254712345682');
});
