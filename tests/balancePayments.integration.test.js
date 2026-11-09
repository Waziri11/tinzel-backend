import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

for (const key of Object.keys(process.env)) if (/^(SMTP_|TWILIO_|NEXTSMS_|TURNSTILE_|BLOB_|VERCEL|MONGODB_|FRONTEND_URL|BACKEND_URL)/.test(key)) delete process.env[key];
process.env.NODE_ENV = 'test';
process.env.DOTENV_CONFIG_PATH = '/private/tmp/tinzel-balance-tests-no-env';
process.env.JWT_SECRET = 'isolated-balance-payment-test-secret';
const { default: app } = await import('../src/app.js');
const { Order } = await import('../src/models/Order.model.js');
const { MagazineForm } = await import('../src/models/MagazineForm.model.js');
const { StaffUser } = await import('../src/models/StaffUser.model.js');
const { Notification } = await import('../src/models/Notification.model.js');
const { AuditLog } = await import('../src/models/AuditLog.model.js');
const { AccessSession } = await import('../src/models/AccessSession.model.js');
const { createSession, digest } = await import('../src/services/accessSessionService.js');
const { generateClientToken } = await import('../src/middlewares/auth.middleware.js');
const { backfillBalancePayments } = await import('../src/services/balancePaymentBackfill.js');
const { paymentSummary } = await import('../src/services/paymentPolicy.js');
const { workflowMessage } = await import('../src/services/workflowMessages.js');
const { reserveFileUpload } = await import('../src/services/fileUploadService.js');
let mongo, server, base, form, manager, designer, staff;

before(async () => {
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  await Promise.all([Order.init(), StaffUser.init(), Notification.init()]);
  form = await MagazineForm.create({ title: 'Balance test', slug: 'balance-test', price: 50000, currency: 'TZS', fields: [] });
  staff = {};
  for (const role of ['manager', 'designer', 'admin']) {
    const user = await StaffUser.create({ name: `Test ${role}`, role, email: `${role}@example.test`, phone: '0712000001', passwordHash: 'unused', preferredLanguage: role === 'manager' ? 'sw' : 'en', isActive: true });
    if (role === 'manager') manager = user;
    if (role === 'designer') designer = user;
    const token = await createSession('staff', user, { verifiedAt: new Date() });
    staff[role] = { Cookie: `tinzel_staff=${token}`, 'X-CSRF-Token': (await AccessSession.findById(digest(token))).csrf };
  }
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await mongo?.stop(); });
async function call(path, body, auth = {}, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5177', ...auth }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = { text }; }
  return { status: response.status, data };
}
async function fresh(extra = {}) {
  const order = await Order.create({ submissionId: randomUUID(), formId: form._id, formTitle: form.title, clientName: 'Payment customer', clientWhatsApp: '0712000010', clientEmail: 'client@example.test', clientPreferredLanguage: 'en',
    totalPrice: 50000, currency: 'TZS', status: 'client_review', assignedDesigner: designer._id, currentDraftVersion: 1,
    paymentDetails: { amountPaid: 25000, lipaNambaReference: 'DEPOSIT-REF', verifiedAt: new Date(), verifiedBy: manager._id },
    draftVersions: [{ versionNumber: 1, assetId: new mongoose.Types.ObjectId(), managerReview: { status: 'approved' } }], ...extra });
  const token = await generateClientToken(order);
  return { order, auth: { Cookie: `tinzel_client=${token}`, 'X-CSRF-Token': (await AccessSession.findById(digest(token))).csrf } };
}
async function approve(fixture) {
  const result = await call('/client/approve-draft', { expectedVersion: 1 }, fixture.auth);
  assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data.order;
}

test('approval requests the exact balance; customer reporting does not count as paid; manager approval unlocks print', async () => {
  const fixture = await fresh(), id = fixture.order._id;
  let client = await approve(fixture);
  assert.equal(client.status, 'awaiting_balance_payment'); assert.equal(client.payment.remaining, 25000);
  assert.equal(client.balancePayments, undefined); assert.equal(client.paymentDetails, undefined);
  assert.equal(client.payment.history[0].reviewedByName, undefined);
  const notices = await Notification.find({ orderId: id, template: 'balance_payment_requested', channel: 'in_system' }).lean();
  assert.ok(notices.some(row => row.recipientRole === 'client' && /25,000/.test(row.message)));
  assert.ok(notices.some(row => row.recipientRole === 'manager' && /Thibitisha/.test(row.message)));
  assert.ok(!notices.some(row => row.recipientRole === 'designer'));
  const listing = await call('/manager/orders?phase=post_design', undefined, staff.manager);
  assert.equal(listing.data.statusCounts.awaiting_balance_payment, 1);
  assert.equal(listing.data.orders.find(row => row._id === String(id)).payment.paid, 25000);
  assert.equal((await call('/client/delivery-location', { location: 'Test delivery area' }, fixture.auth, 'PATCH')).status, 200);
  assert.notEqual((await call(`/designer/orders/${id}/upload-print-document`, { useApprovedDraft: true }, staff.designer)).status, 200);
  let result = await call('/client/balance-payment', { reference: 'BALANCE-1', amount: 25000, status: 'approved', reviewedBy: manager._id }, fixture.auth);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.order.status, 'balance_payment_review'); assert.equal(result.data.order.payment.paid, 25000);
  const paymentId = result.data.order.payment.pending._id;
  assert.equal((await call('/client/balance-payment', { reference: ' balance-1 ', amount: 25000 }, fixture.auth)).status, 200);
  assert.equal((await Order.findById(id)).balancePayments.length, 1);
  assert.equal((await call(`/manager/orders/${id}/balance-payment`, { paymentId, decision: 'approve' }, staff.designer)).status, 403);
  result = await call(`/manager/orders/${id}/balance-payment`, { paymentId, decision: 'approve' }, staff.manager);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.order.status, 'client_approved'); assert.equal(result.data.order.payment.paid, 50000);
  assert.equal(result.data.order.payment.remaining, 0); assert.equal(result.data.order.paymentDetails.amountPaid, 25000);
  assert.equal(result.data.order.payment.history[1].reviewedByName, manager.name);
  assert.equal((await call(`/manager/orders/${id}/balance-payment`, { paymentId, decision: 'approve' }, staff.admin)).status, 200);
  assert.equal(await AuditLog.countDocuments({ orderId: id, action: 'BALANCE_PAYMENT_VERIFIED' }), 1);
  const paidNotices = await Notification.find({ orderId: id, template: 'balance_payment_verified', channel: 'in_system' }).lean();
  assert.ok(paidNotices.some(row => row.recipientRole === 'designer' && /fully paid/.test(row.message)));
  assert.ok(paidNotices.some(row => row.recipientRole === 'client' && /full payment/.test(row.message)));
  result = await call(`/designer/orders/${id}/upload-print-document`, { useApprovedDraft: true }, staff.designer);
  assert.equal(result.status, 200, JSON.stringify(result.data));
});

test('full upfront payments skip the balance gate, while exact Express balances include the fee', async () => {
  const paid = await fresh({ paymentDetails: { amountPaid: 50000, verifiedAt: new Date(), lipaNambaReference: 'FULL' } });
  const result = await approve(paid); assert.equal(result.status, 'client_approved'); assert.equal(result.payment.fullyPaid, true);
  assert.equal(await Notification.countDocuments({ orderId: paid.order._id, template: 'balance_payment_requested' }), 0);
  const express = await fresh({ totalPrice: 70000, basePrice: 50000, expressFee: 20000, isExpress: true, paymentDetails: { amountPaid: 35000, verifiedAt: new Date(), lipaNambaReference: 'EXPRESS' } });
  assert.equal((await approve(express)).payment.remaining, 35000);
});

test('rejected and partial payments preserve history and cannot release an unpaid order to print', async () => {
  const fixture = await fresh(), id = fixture.order._id; await approve(fixture);
  assert.equal((await call('/client/balance-payment', { reference: 'DEPOSIT-REF', amount: 25000 }, fixture.auth)).status, 409);
  assert.equal((await call('/client/balance-payment', { reference: 'EXCESS', amount: 25000.01 }, fixture.auth)).status, 400);
  let result = await call('/client/balance-payment', { reference: 'FIRST', amount: 10000 }, fixture.auth);
  const firstId = result.data.order.payment.pending._id;
  assert.equal((await call(`/manager/orders/${id}/balance-payment`, { paymentId: firstId, decision: 'reject', reason: '' }, staff.manager)).status, 400);
  result = await call(`/manager/orders/${id}/balance-payment`, { paymentId: firstId, decision: 'reject', reason: 'The reference does not match the received payment.' }, staff.manager);
  assert.equal(result.status, 200); assert.equal(result.data.order.payment.remaining, 25000);
  result = await call('/client/balance-payment', { reference: 'FIRST', amount: 10000 }, fixture.auth);
  const newId = result.data.order.payment.pending._id; assert.notEqual(newId, firstId);
  result = await call(`/manager/orders/${id}/balance-payment`, { paymentId: newId, decision: 'approve' }, staff.manager);
  assert.equal(result.data.order.status, 'awaiting_balance_payment'); assert.equal(result.data.order.payment.remaining, 15000);
  assert.equal(await Notification.countDocuments({ orderId: id, template: 'balance_payment_verified', recipientRole: 'designer' }), 0);
  // Legacy/unmigrated statuses must not bypass the server gate.
  await Order.updateOne({ _id: id }, { $set: { status: 'client_approved' } });
  assert.equal((await call(`/designer/orders/${id}/upload-print-document`, { useApprovedDraft: true }, staff.designer)).status, 409);
  await assert.rejects(reserveFileUpload(designer, { purpose: 'print', orderId: id }), error => error.status === 409);
  await Order.updateOne({ _id: id }, { $set: { status: 'print_manager_review', 'printDocument.url': '/api/public/drafts/test', 'printDocument.uploadedAt': new Date() } });
  assert.equal((await call(`/manager/orders/${id}/authorise-print`, {}, staff.manager)).status, 409);
  result = await call(`/manager/orders/${id}/balance-payment`, { decision: 'approve', reference: 'FINAL', amount: 15000 }, staff.manager);
  assert.equal(result.status, 200); assert.equal(result.data.order.status, 'print_manager_review'); assert.equal(result.data.order.payment.fullyPaid, true);
  assert.equal(result.data.order.payment.history.length, 4);
});

test('concurrent approvals count once, pending requests cannot be replaced, and clients cannot submit for another order', async () => {
  const fixture = await fresh(), other = await fresh(); await approve(fixture);
  assert.equal((await call('/client/balance-payment', { reference: 'NOT-YET', amount: 100 }, other.auth)).status, 409);
  const result = await call('/client/balance-payment', { orderId: other.order._id, reference: 'CONCURRENT', amount: 25000 }, fixture.auth);
  assert.equal(result.status, 200); assert.equal((await Order.findById(other.order._id)).balancePayments.length, 0);
  assert.equal((await call('/client/balance-payment', { reference: 'REPLACEMENT', amount: 1 }, fixture.auth)).status, 409);
  const path = `/manager/orders/${fixture.order._id}/balance-payment`, body = { paymentId: result.data.order.payment.pending._id, decision: 'approve' };
  const responses = await Promise.all([call(path, body, staff.manager), call(path, body, staff.admin)]);
  assert.ok(responses.some(row => row.status === 200)); assert.ok(responses.every(row => [200, 409].includes(row.status)));
  const order = await Order.findById(fixture.order._id); assert.equal(paymentSummary(order).paid, 50000); assert.equal(order.balancePayments.length, 1);
  assert.equal(await AuditLog.countDocuments({ orderId: order._id, action: 'BALANCE_PAYMENT_VERIFIED' }), 1);
});

test('legacy migration is repeatable, respects holds and dispatched jobs, and snapshots prices', async () => {
  const legacy = await fresh({ status: 'client_approved', approvedVersionNumber: 1, totalPrice: undefined });
  const held = await fresh({ status: 'on_hold', previousStatusBeforeHold: 'print_manager_review', approvedVersionNumber: 1 });
  const sent = await fresh({ status: 'printing_sent', approvedVersionNumber: 1 });
  const before = await backfillBalancePayments(); assert.ok(before.candidates >= 2); assert.equal(before.updated, 0);
  await backfillBalancePayments({ apply: true });
  const migrated = await Order.findById(legacy.order._id); assert.equal(migrated.status, 'awaiting_balance_payment'); assert.equal(migrated.totalPrice, 50000);
  const hold = await Order.findById(held.order._id); assert.equal(hold.status, 'on_hold'); assert.equal(hold.previousStatusBeforeHold, 'awaiting_balance_payment');
  assert.equal((await Order.findById(sent.order._id)).status, 'printing_sent');
  assert.equal((await backfillBalancePayments({ apply: true })).updated, 0);
  for (const lang of ['en', 'sw']) {
    const message = workflowMessage('balance_payment_requested', migrated, { balanceRemaining: 25000 }, { role: 'client', channel: 'in_system' }, lang, '');
    assert.match(message.message, /25,000/); assert.doesNotMatch(message.message, /\{\w+\}/);
  }
});
