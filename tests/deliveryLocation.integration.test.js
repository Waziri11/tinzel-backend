import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env.NODE_ENV = 'test';
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.JWT_SECRET = 'isolated-delivery-location-test-secret';
const { default: app } = await import('../src/app.js');
const { Order } = await import('../src/models/Order.model.js');
const { StaffUser } = await import('../src/models/StaffUser.model.js');
const { AuditLog } = await import('../src/models/AuditLog.model.js');
const { generateClientToken, generateToken } = await import('../src/middlewares/auth.middleware.js');
const { updateNotificationSettings } = await import('../src/services/notificationService.js');
let mongo, server, base, managerToken;

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await updateNotificationSettings({ channels: { in_system: false, email: false, sms: false, whatsapp: false } });
  const manager = await StaffUser.create({ name: 'Delivery manager', email: 'delivery@example.test', role: 'manager', passwordHash: 'unused' });
  managerToken = await generateToken(manager, { verifiedAt: new Date() });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server?.closeAllConnections();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  await mongoose.disconnect();
  await mongo?.stop();
});
async function fixture(extra = {}) {
  const order = await Order.create({ submissionId: `SUB-DELIVERY-${new mongoose.Types.ObjectId()}`, formId: new mongoose.Types.ObjectId(), clientName: 'Delivery client', clientWhatsApp: '0712000000',
    status: 'client_review', currentDraftVersion: 1, draftVersions: [{ versionNumber: 1, managerReview: { status: 'approved' } }], ...extra });
  return { order, token: await generateClientToken(order) };
}
async function call(path, token, data, method = data ? 'PATCH' : 'GET', extraHeaders = {}) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders }, ...(data ? { body: JSON.stringify(data) } : {}) });
  return { status: response.status, body: await response.json() };
}
const save = (token, location, extra = {}) => call('/api/client/delivery-location', token, { location, ...extra });

test('approval, location save, client reload, manager handoff and dispatch preserve the location', async () => {
  const { order, token } = await fixture();
  const approval = await call('/api/client/approve-draft', token, { expectedVersion: 1 }, 'POST');
  assert.equal(approval.status, 200, JSON.stringify(approval.body));
  assert.equal(approval.body.order.status, 'client_approved');
  const saved = await save(token, '  Dar es Salaam, Mikocheni\nNear the library  ');
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.clientDeliveryDetails.location, 'Dar es Salaam, Mikocheni\nNear the library');
  assert.ok(saved.body.clientDeliveryDetails.updatedAt);
  assert.equal((await Order.findById(order._id)).status, 'client_approved');
  const reloaded = await call('/api/client/order', token);
  assert.deepEqual(reloaded.body.order.clientDeliveryDetails, saved.body.clientDeliveryDetails);
  const managed = await call(`/api/manager/orders/${order._id}`, managerToken);
  assert.deepEqual(managed.body.order.clientDeliveryDetails, saved.body.clientDeliveryDetails);
  assert.ok(await AuditLog.exists({ orderId: order._id, action: 'CLIENT_DELIVERY_LOCATION_SAVED' }));
  await Order.updateOne({ _id: order._id }, { $set: { status: 'printing_completed' } });
  assert.equal((await save(token, 'Updated delivery location')).status, 200);
  const dispatched = await call(`/api/manager/orders/${order._id}/authorise-dispatch`, managerToken,
    { carrier: 'Test courier', trackingReference: 'TEST-DELIVERY', deliveryAddress: 'Updated delivery location' }, 'POST');
  assert.equal(dispatched.status, 200, JSON.stringify(dispatched.body));
  assert.equal((await save(token, 'Too late')).status, 409);
  const final = await Order.findById(order._id);
  assert.equal(final.dispatchDetails.deliveryAddress, 'Updated delivery location');
  assert.equal(final.clientDeliveryDetails.location, 'Updated delivery location');
});

test('location requires client access and belongs only to the authenticated order', async () => {
  const first = await fixture({ status: 'client_approved' });
  const second = await fixture({ status: 'client_approved' });
  assert.equal((await save(null, 'Unauthenticated')).status, 401);
  assert.equal((await save(managerToken, 'Wrong session')).status, 401);
  assert.equal((await save(first.token, 'First client location', { orderId: second.order._id })).status, 200);
  assert.equal((await Order.findById(second.order._id)).clientDeliveryDetails?.location || '', '');
  assert.equal((await call('/api/client/order', second.token)).body.order.clientDeliveryDetails.location, '');
  const csrf = await call('/api/client/delivery-location', null, { location: 'No CSRF' }, 'PATCH', { Cookie: `tinzel_client=${first.token}`, Origin: 'http://127.0.0.1:5177' });
  assert.equal(csrf.status, 403);
});

test('invalid input and unavailable stages cannot change the saved location', async () => {
  const { order, token } = await fixture({ status: 'client_approved', clientDeliveryDetails: { location: 'Original location' } });
  for (const value of ['', '  \n ', null, {}, 123, 'x'.repeat(1001)]) assert.equal((await save(token, value)).status, 400);
  assert.equal((await Order.findById(order._id)).clientDeliveryDetails.location, 'Original location');
  for (const status of ['awaiting_payment', 'client_review', 'revision_requested', 'dispatched', 'delivered', 'closed']) {
    await Order.updateOne({ _id: order._id }, { $set: { status } });
    assert.equal((await save(token, 'Wrong stage')).status, 409, status);
  }
  assert.equal((await Order.findById(order._id)).clientDeliveryDetails.location, 'Original location');
});

test('the prompt can be completed during print preparation and an approved order hold', async () => {
  const { order, token } = await fixture();
  for (const status of ['print_document_prep', 'print_manager_review', 'printing_sent', 'printing_in_progress', 'on_hold']) {
    await Order.updateOne({ _id: order._id }, { $set: { status, previousStatusBeforeHold: 'client_approved' } });
    assert.equal((await save(token, `Location at ${status}`)).status, 200, status);
  }
  await Order.updateOne({ _id: order._id }, { $set: { previousStatusBeforeHold: 'client_review' } });
  assert.equal((await save(token, 'Unapproved hold')).status, 409);
});
