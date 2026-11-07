import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
process.env.NODE_ENV = 'test';
process.env.SECURITY_OTP_SINK = 'true';
process.env.JWT_SECRET = 'payment-options-isolated-test-key';
const { default: app } = await import('../src/app.js');
const { StaffUser } = await import('../src/models/StaffUser.model.js');
const { SystemConfig } = await import('../src/models/SystemConfig.model.js');
const { MagazineForm } = await import('../src/models/MagazineForm.model.js');
const { Order } = await import('../src/models/Order.model.js');
const { AuditLog } = await import('../src/models/AuditLog.model.js');
const { AccessSession } = await import('../src/models/AccessSession.model.js');
const { createSession, digest } = await import('../src/services/accessSessionService.js');
const { getPublicPaymentDetails } = await import('../src/services/paymentOptionsService.js');
let db, server, base, form, auth;
const legacy = { tillNumber: 'OLD-TEST', accountName: 'Old test account', instructions: 'Old instructions' };
const options = [
  { id: 'mobile', type: 'mobile', enabled: true, name: ' Test mobile ', number: ' TEST-001 ', accountName: 'Test account', instructions: 'Use your name.', instructionsSw: 'Tumia jina lako.' },
  { id: 'bank', type: 'bank', enabled: true, name: 'Test bank', number: 'TEST-002', accountName: 'Test account', instructions: 'Use the bank app.' },
  { id: 'hidden', type: 'till', enabled: false, name: 'Hidden till', number: 'HIDDEN', accountName: 'Test', instructions: 'Hidden instructions' },
];
before(async () => {
  db = await MongoMemoryServer.create(); await mongoose.connect(db.getUri());
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  form = await MagazineForm.create({ title: 'Payments test', slug: 'payments-test', isActive: true, price: 50000, fields: [], lipaNambaInstructions: legacy });
  auth = {};
  for (const role of ['admin', 'manager', 'designer']) {
    const user = await StaffUser.create({ name: role, email: `${role}@example.test`, passwordHash: 'unused', role });
    const token = await createSession('staff', user, { verifiedAt: new Date() });
    auth[role] = { Cookie: `tinzel_staff=${token}`, 'X-CSRF-Token': (await AccessSession.findById(digest(token))).csrf };
  }
});
beforeEach(async () => { await SystemConfig.deleteMany({}); });
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await db.stop(); });
async function call(path, body, headers = {}, method = body === undefined ? 'GET' : 'POST') {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5177', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
const save = (value, role = 'admin') => call('/api/admin/config', { key: 'payment_options', value }, auth[role], 'PUT');
test('admin persists multiple ordered methods; disabled options and unrelated settings stay private', async () => {
  for (const role of ['manager', 'designer']) assert.equal((await save(options, role)).status, 403);
  assert.equal((await call('/api/admin/config', { key: 'payment_options', value: options }, {}, 'PUT')).status, 401);
  const result = await save(options); assert.equal(result.status, 200);
  assert.equal(result.data.config.value[0].number, 'TEST-001');
  const read = await call('/api/admin/config', undefined, auth.admin);
  assert.equal(read.data.configs.find(config => config.key === 'payment_options').value.length, 3);
  assert.ok(await AuditLog.exists({ action: 'SYSTEM_CONFIG_UPDATED', 'details.key': 'payment_options' }));
  await SystemConfig.create({ key: 'private_test_setting', value: 'not-public' });
  const details = await getPublicPaymentDetails(legacy);
  assert.deepEqual(details.paymentOptions.map(option => option.id), ['mobile', 'bank']);
  assert.equal(details.lipaNambaInstructions, null);
  assert.equal(JSON.stringify(details).includes('not-public'), false);
});
test('rejects malformed, incomplete, excessive and duplicate options without overwriting saved details', async () => {
  await save(options);
  for (const value of [null, {}, [null], [{ ...options[0], number: '' }], [{ ...options[0], type: 'bad' }], [{ ...options[0], enabled: 'true' }], [{ ...options[0], instructions: 'x'.repeat(2001) }], [options[0], options[0]], [options[0], { ...options[0], id: ' mobile ' }], [{ ...options[0], privateKey: 'bad' }], Array.from({ length: 21 }, (_, i) => ({ ...options[0], id: String(i) }))]) {
    assert.equal((await save(value)).status, 400, JSON.stringify(value)?.slice(0, 100));
  }
  assert.equal((await getPublicPaymentDetails(legacy)).paymentOptions.length, 2);
});
test('only absent settings use legacy details; empty/disabled configuration never revives old destinations', async () => {
  assert.equal((await getPublicPaymentDetails(legacy)).paymentOptions[0].number, 'OLD-TEST');
  assert.deepEqual((await getPublicPaymentDetails({})).paymentOptions, []);
  await save([]); assert.deepEqual((await getPublicPaymentDetails(legacy)).paymentOptions, []);
  await save(options.map(option => ({ ...option, enabled: false })));
  assert.equal((await getPublicPaymentDetails(legacy)).lipaNambaInstructions, null);
});
test('both submission paths use settings; retries and tracking pick up changes without duplicate orders', async () => {
  await save(options);
  const body = { clientName: 'Payment fixture', clientWhatsApp: '0712000001', answers: {}, assetIds: [] };
  const original = await call(`/api/public/forms/${form.slug}/submit`, body);
  assert.equal(original.status, 201, JSON.stringify(original.data));
  assert.deepEqual(original.data.paymentOptions.map(option => option.id), ['mobile', 'bank']);
  assert.equal(original.data.lipaNambaInstructions, null);
  const id = randomUUID(), headers = { 'X-Upload-Token': randomBytes(32).toString('hex') };
  assert.equal((await call('/api/public/media/sessions', { id, slug: form.slug }, headers)).status, 201);
  const submitted = await call(`/api/public/media/sessions/${id}/submit`, body, headers);
  assert.equal(submitted.status, 201, JSON.stringify(submitted.data));
  assert.deepEqual(submitted.data.paymentOptions, original.data.paymentOptions);
  await save([{ ...options[1], number: 'NEW-TEST' }]);
  const retry = await call(`/api/public/media/sessions/${id}/submit`, body, headers);
  assert.equal(retry.data.paymentOptions[0].number, 'NEW-TEST');
  assert.equal(retry.data.order.submissionId, submitted.data.order.submissionId);
  assert.equal(await Order.countDocuments({ mediaSessionId: id }), 1);
  const order = await Order.findOne({ mediaSessionId: id });
  const { generateClientToken } = await import('../src/middlewares/auth.middleware.js');
  const token = await generateClientToken(order);
  const tracking = await call('/api/client/order', undefined, { Cookie: `tinzel_client=${token}` });
  assert.equal(tracking.status, 200, JSON.stringify(tracking.data));
  assert.equal(tracking.data.order.paymentOptions[0].number, 'NEW-TEST');
});
