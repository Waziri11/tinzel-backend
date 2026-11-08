import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
process.env.NODE_ENV = 'test';
process.env.SECURITY_OTP_SINK = 'true';
process.env.JWT_SECRET = 'express-orders-isolated-test-key';
const { default: app } = await import('../src/app.js');
const { StaffUser } = await import('../src/models/StaffUser.model.js');
const { MagazineForm } = await import('../src/models/MagazineForm.model.js');
const { Order } = await import('../src/models/Order.model.js');
const { Notification } = await import('../src/models/Notification.model.js');
const { AccessSession } = await import('../src/models/AccessSession.model.js');
const { createSession, digest } = await import('../src/services/accessSessionService.js');
const { expressDeadline, standardDeadline } = await import('../src/services/expressOrderService.js');
let db, server, base, form, auth, designer, expressId;
before(async () => {
  db = await MongoMemoryServer.create(); await mongoose.connect(db.getUri());
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  form = await MagazineForm.create({ title: 'Express test', slug: 'express-test', isActive: true, price: 50000, fields: [] });
  auth = {};
  for (const role of ['manager', 'designer']) {
    const user = await StaffUser.create({ name: role, email: `${role}@example.test`, passwordHash: 'unused', role, isActive: true, mustChangePassword: false, isEligibleForAssignment: true, maxActiveWorkload: 30 });
    if (role === 'designer') designer = user;
    const token = await createSession('staff', user, { verifiedAt: new Date() });
    auth[role] = { Cookie: `tinzel_staff=${token}`, 'X-CSRF-Token': (await AccessSession.findById(digest(token))).csrf };
  }
});
after(async () => { server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await db?.stop(); });
async function call(path, body, headers = {}, method = body === undefined ? 'GET' : 'POST') {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5177', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
const body = { clientName: 'Express fixture', clientWhatsApp: '0712000001', answers: {}, assetIds: [], isExpress: true, expressFee: 1, totalPrice: 1, expressDueAt: '2100-01-01T00:00:00Z' };

test('both submission paths save the server price; session retries cannot change the selection or price', async () => {
  const legacy = await call(`/api/public/forms/${form.slug}/submit`, body);
  assert.equal(legacy.status, 201, JSON.stringify(legacy.data));
  assert.equal(legacy.data.order.price, 70000);
  assert.equal(legacy.data.order.expressFee, 20000);
  assert.equal(legacy.data.order.expressDueAt, undefined);
  const invalid = await call(`/api/public/forms/${form.slug}/submit`, { ...body, isExpress: 'yes' });
  assert.equal(invalid.status, 400);
  const id = randomUUID(), headers = { 'X-Upload-Token': randomBytes(32).toString('hex') };
  assert.equal((await call('/api/public/media/sessions', { id, slug: form.slug }, headers)).status, 201);
  const submitted = await call(`/api/public/media/sessions/${id}/submit`, body, headers);
  assert.equal(submitted.status, 201, JSON.stringify(submitted.data));
  const saved = await Order.findOne({ mediaSessionId: id }); expressId = String(saved._id);
  assert.equal(saved.isExpress, true); assert.equal(saved.totalPrice, 70000); assert.equal(saved.expressStartedAt, undefined);
  await MagazineForm.updateOne({ _id: form._id }, { $set: { price: 90000 } });
  const retry = await call(`/api/public/media/sessions/${id}/submit`, { ...body, isExpress: false }, headers);
  assert.equal(retry.data.order.price, 70000); assert.equal(retry.data.order.isExpress, true);
  assert.equal(await Order.countDocuments({ mediaSessionId: id }), 1);
  const { generateClientToken } = await import('../src/middlewares/auth.middleware.js');
  const token = await generateClientToken(saved);
  const tracking = await call('/api/client/order', undefined, { Cookie: `tinzel_client=${token}` });
  assert.equal(tracking.data.order.price, 70000); assert.equal(tracking.data.order.isExpress, true);
  await MagazineForm.updateOne({ _id: form._id }, { $set: { price: 50000 } });
  const standard = await call(`/api/public/forms/${form.slug}/submit`, { ...body, isExpress: false });
  assert.equal(standard.data.order.price, 50000); assert.equal(standard.data.order.expressFee, 0);
});

test('50% express deposit starts the clock once, auto-assignment preserves it, and alerts name express', async () => {
  const path = `/api/manager/orders/${expressId}/verify-payment`;
  assert.equal((await call(path, { lipaNambaReference: 'EXPRESS-TEST', amountPaid: 34999 }, auth.manager)).status, 400);
  assert.equal((await Order.findById(expressId)).expressStartedAt, undefined);
  const paid = await call(path, { lipaNambaReference: 'EXPRESS-TEST', amountPaid: 35000 }, auth.manager);
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  const saved = await Order.findById(expressId);
  assert.equal(saved.status, 'assigned');
  assert.equal(saved.paymentDetails.amountPaid, 35000);
  assert.equal(+saved.expressStartedAt, +saved.paymentDetails.verifiedAt);
  assert.equal(+saved.expressDueAt, +expressDeadline(saved.paymentDetails.verifiedAt));
  const retry = await call(path, { lipaNambaReference: 'EXPRESS-TEST', amountPaid: 35000 }, auth.manager);
  assert.equal(retry.data.order.expressDueAt, saved.expressDueAt.toISOString());
  saved.status = 'in_design'; await saved.save();
  assert.equal((await Order.findById(expressId)).expressDueAt.toISOString(), retry.data.order.expressDueAt);
  const alerts = await Notification.find({ orderId: saved._id, channel: 'in_system' }).lean();
  assert.ok(alerts.some(row => /EXPRESS/.test(row.title) && /EXPRESS/.test(row.message)), 'express alert saved for staff');
});

test('express sorts ahead of newer standard orders before pagination in every phase and returns', async () => {
  const saved = await Order.findById(expressId);
  for (const [status, phase, column] of [
    ['awaiting_payment', 'pre_design', 'new'], ['in_design', 'design_phase', 'new'],
    ['revision_requested', 'design_phase', 'manager'], ['printing_in_progress', 'post_design', 'completed'],
  ]) {
    const revisionRequests = status === 'revision_requested' ? [{ roundNumber: 1, draftVersionNumber: 1, source: 'manager', requestedBy: { type: 'manager' }, items: [{ text: 'Test correction' }] }] : [];
    saved.status = status; saved.revisionRequests = revisionRequests; await saved.save();
    // Keep only this express candidate in this phase while testing the first page.
    await Order.updateMany({ _id: { $ne: saved._id }, isExpress: true }, { $set: { isExpress: false } });
    await Order.create({ submissionId: randomUUID(), clientName: 'Newer standard', clientWhatsApp: '0712000002', formId: form._id, assignedDesigner: designer._id, status, revisionRequests });
    const manager = await call(`/api/manager/orders?phase=${phase}&limit=1`, undefined, auth.manager);
    assert.equal(manager.data.orders[0]._id, expressId, phase);
    assert.ok(manager.data.total > 1);
    const design = await call(`/api/designer/orders?column=${column}&limit=1`, undefined, auth.designer);
    assert.equal(design.data.orders[0]._id, expressId, column);
    assert.equal(design.data.orders[0].expressDueAt, saved.expressDueAt.toISOString());
    if (status === 'revision_requested') {
      const returns = await call('/api/designer/returns?limit=1', undefined, auth.designer);
      assert.equal(returns.data.returns[0].orderId, expressId);
      assert.equal(returns.data.returns[0].isExpress, true);
    }
  }
});

test('standard and legacy orders accept a half deposit, reject less, and still allow full payment', async () => {
  for (const legacy of [false, true]) {
    const order = await Order.create({ submissionId: randomUUID(), clientName: 'Deposit fixture', clientWhatsApp: '0712000003', formId: form._id, status: 'awaiting_payment', ...(legacy ? {} : { totalPrice: 50000, basePrice: 50000, expressFee: 0, currency: 'TZS' }) });
    const path = `/api/manager/orders/${order._id}/verify-payment`;
    const tooLittle = await call(path, { lipaNambaReference: 'DEPOSIT-TEST', amountPaid: 24999 }, auth.manager);
    assert.equal(tooLittle.status, 400);
    assert.match(tooLittle.data.message, /50% deposit/);
    assert.equal((await Order.findById(order._id)).status, 'awaiting_payment');
    const paid = await call(path, { lipaNambaReference: 'DEPOSIT-TEST', amountPaid: legacy ? 50000 : 25000 }, auth.manager);
    assert.equal(paid.status, 200, JSON.stringify(paid.data));
    assert.equal(paid.data.order.status, 'assigned');
    assert.equal(paid.data.order.expressStartedAt, undefined);
    const saved = await Order.findById(order._id);
    assert.equal(+saved.standardStartedAt, +saved.paymentDetails.verifiedAt);
    assert.equal(+saved.standardDueAt, +standardDeadline(saved.paymentDetails.verifiedAt));
    const retry = await call(path, { lipaNambaReference: 'DEPOSIT-TEST', amountPaid: 50000 }, auth.manager);
    assert.equal(retry.data.order.standardDueAt, saved.standardDueAt.toISOString());
    saved.status = 'in_design'; await saved.save();
    const manager = await call('/api/manager/orders?scope=all&limit=100', undefined, auth.manager);
    const design = await call('/api/designer/orders?column=new&limit=100', undefined, auth.designer);
    for (const response of [manager, design]) {
      const row = response.data.orders.find(row => row._id === String(saved._id));
      assert.equal(row.standardStartedAt, saved.standardStartedAt.toISOString());
      assert.equal(row.standardDueAt, saved.standardDueAt.toISOString());
    }
    const { generateClientToken } = await import('../src/middlewares/auth.middleware.js');
    const token = await generateClientToken(saved);
    const tracking = await call('/api/client/order', undefined, { Cookie: `tinzel_client=${token}` });
    assert.equal(tracking.data.order.standardDueAt, saved.standardDueAt.toISOString());
    saved.status = 'revision_requested';
    saved.revisionRequests = [{ roundNumber: 1, draftVersionNumber: 1, source: 'manager', requestedBy: { type: 'manager' }, items: [{ text: 'Correction' }] }];
    await saved.save();
    const returns = await call('/api/designer/returns?limit=100', undefined, auth.designer);
    assert.equal(returns.data.returns.find(row => row.orderId === String(saved._id)).standardDueAt, saved.standardDueAt.toISOString());
  }
});
