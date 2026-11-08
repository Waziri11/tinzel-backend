import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

process.env.NODE_ENV = 'test';
process.env.SECURITY_OTP_SINK = 'true';
process.env.JWT_SECRET = 'submission-deletion-isolated-test-key';
const { default: app } = await import('../src/app.js');
const { StaffUser } = await import('../src/models/StaffUser.model.js');
const { Order } = await import('../src/models/Order.model.js');
const { AuditLog } = await import('../src/models/AuditLog.model.js');
const { AccessSession } = await import('../src/models/AccessSession.model.js');
const { MediaJob } = await import('../src/models/Media.model.js');
const { createSession, digest } = await import('../src/services/accessSessionService.js');
const { cleanExpiredOrders } = await import('../src/services/orderRetentionService.js');
const oid = () => new mongoose.Types.ObjectId();
let mongo, server, base, auth = {}, users = {};

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all([StaffUser.init(), Order.init(), AuditLog.init(), AccessSession.init()]);
  for (const role of ['admin', 'manager', 'designer']) {
    const user = users[role] = await StaffUser.create({ name: role, email: `${role}@example.test`, role, passwordHash: 'unused' });
    const token = await createSession('staff', user, { verifiedAt: new Date() });
    auth[role] = { Cookie: `tinzel_staff=${token}`, 'X-CSRF-Token': (await AccessSession.findById(digest(token))).csrf };
  }
  const stale = await createSession('staff', users.admin, { verifiedAt: new Date(Date.now() - 11 * 60000) });
  auth.stale = { Cookie: `tinzel_staff=${stale}`, 'X-CSRF-Token': (await AccessSession.findById(digest(stale))).csrf };
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  for (const collection of await mongoose.connection.db.collections()) {
    if (!['staffusers', 'accesssessions'].includes(collection.collectionName)) await collection.deleteMany({});
  }
  await StaffUser.updateOne({ _id: users.designer._id }, { $set: { currentActiveWorkload: 2 } });
});
after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect(); await mongo?.stop();
});
const submission = (extra = {}) => Order.create({ submissionId: String(oid()), formId: oid(), clientName: 'Deletion fixture', clientWhatsApp: 'test', status: 'in_design', assignedDesigner: users.designer._id, ...extra });
async function call(path, headers = auth.admin, method = 'DELETE', body = { confirmation: 'DELETE' }) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5177', ...headers }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}

test('deletion requires admin, recent SMS verification, CSRF and explicit confirmation', async () => {
  const order = await submission(); const path = `/api/admin/submissions/${order._id}`;
  assert.equal((await call(path, {})).status, 401);
  for (const role of ['manager', 'designer']) assert.equal((await call(path, auth[role])).status, 403);
  assert.equal((await call(path, { Cookie: auth.admin.Cookie })).status, 403);
  const stale = await call(path, auth.stale); assert.equal(stale.status, 403); assert.equal(stale.body.errorCode, 'OTP_REQUIRED');
  for (const confirmation of [undefined, false, 'delete']) assert.equal((await call(path, auth.admin, 'DELETE', { confirmation })).status, 400);
  assert.ok(await Order.findById(order._id));
  assert.equal((await call('/api/admin/submissions/invalid')).status, 404);
  assert.equal((await call(`/api/admin/submissions/${oid()}`)).status, 404);
});

test('deletion immediately hides an active submission, revokes customer access and rejects stale saves', async () => {
  const order = await submission(); const other = await submission({ assignedDesigner: undefined });
  const clientToken = await createSession('client', order);
  const result = await call(`/api/admin/submissions/${order._id}`);
  assert.equal(result.status, 202); assert.equal(result.body.state, 'deleting');
  assert.equal(await Order.findById(order._id), null);
  assert.equal((await call(`/api/manager/orders/${order._id}`, auth.admin, 'GET')).status, 404);
  const list = await call('/api/manager/orders?scope=all', auth.admin, 'GET');
  assert.equal(list.body.orders.some(row => row._id === String(order._id)), false);
  const customer = await call('/api/client/order', { Authorization: `Bearer ${clientToken}` }, 'GET');
  assert.equal(customer.status, 401);
  order.holdReason = 'stale edit'; await assert.rejects(order.save(), { name: 'VersionError' });
  assert.ok(await Order.findById(other._id));
  assert.equal((await StaffUser.findById(users.designer._id)).currentActiveWorkload, 1);
});

test('concurrent deletion and retry release workload and record the administrator exactly once', async () => {
  const order = await submission(); const path = `/api/admin/submissions/${order._id}`;
  const results = await Promise.all([call(path), call(path)]);
  assert.deepEqual(results.map(result => result.status), [202, 202]);
  assert.equal((await StaffUser.findById(users.designer._id)).currentActiveWorkload, 1);
  const audit = await AuditLog.find({ action: 'SUBMISSION_DELETION_REQUESTED' });
  assert.equal(audit.length, 1); assert.equal(audit[0].actor.id, String(users.admin._id));
  assert.equal(audit[0].orderId, undefined);
  assert.equal(JSON.stringify(audit).includes(order.clientName), false);
  await cleanExpiredOrders({ now: new Date(Date.now() + 6 * 60000) });
  assert.equal(await Order.collection.countDocuments({ _id: order._id }), 0);
  assert.equal((await call(path)).body.state, 'deleted');
  assert.equal(await AuditLog.countDocuments({ action: 'SUBMISSION_DELETION_REQUESTED' }), 1);
});

test('cleanup removes files after the drain interval, preserves unrelated files and waits for running jobs', async () => {
  const db = mongoose.connection.db, photo = oid(), draft = oid(), other = oid();
  const order = await submission({ uploadedPhotos: [{ assetId: String(photo) }], draftVersions: [{ versionNumber: 1, assetId: draft }] });
  for (const [bucket, id] of [['orderPhotos', photo], ['draftFiles', draft], ['orderPhotos', other]]) {
    await db.collection(`${bucket}.files`).insertOne({ _id: id });
    await db.collection(`${bucket}.chunks`).insertOne({ files_id: id, n: 0, data: Buffer.from('fixture') });
  }
  await call(`/api/admin/submissions/${order._id}`);
  assert.equal((await cleanExpiredOrders()).pending, 1);
  await MediaJob.create({ _id: 'active', kind: 'proof', orderId: order._id, state: 'running', leaseUntil: new Date(Date.now() + 3600000) });
  const drained = new Date(Date.now() + 6 * 60000);
  assert.equal((await cleanExpiredOrders({ now: drained })).pending, 1);
  await MediaJob.updateOne({ _id: 'active' }, { state: 'ready' });
  assert.equal((await cleanExpiredOrders({ now: drained })).deleted, 1);
  for (const [bucket, id] of [['orderPhotos', photo], ['draftFiles', draft]]) {
    assert.equal(await db.collection(`${bucket}.chunks`).countDocuments({ files_id: id }), 0);
    assert.equal(await db.collection(`${bucket}.files`).countDocuments({ _id: id }), 0);
  }
  assert.equal(await db.collection('orderPhotos.files').countDocuments({ _id: other }), 1);
});

test('closed submissions do not release workload again; failed audit rolls back the whole request', async () => {
  const closed = await submission({ status: 'closed' });
  assert.equal((await call(`/api/admin/submissions/${closed._id}`)).status, 202);
  assert.equal((await StaffUser.findById(users.designer._id)).currentActiveWorkload, 2);
  const active = await submission();
  const original = AuditLog.create;
  AuditLog.create = async () => { throw new Error('Fixture audit failure'); };
  try { assert.equal((await call(`/api/admin/submissions/${active._id}`)).status, 500); }
  finally { AuditLog.create = original; }
  assert.ok(await Order.findById(active._id));
  assert.equal((await StaffUser.findById(users.designer._id)).currentActiveWorkload, 2);
});
