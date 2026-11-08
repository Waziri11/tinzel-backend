import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'isolated-kanban-transition-test-secret';
for (const key of Object.keys(process.env)) {
  if (/^(SMTP_|TWILIO_|NEXTSMS_|BLOB_|MONGODB_)/.test(key)) delete process.env[key];
}
const { default: app } = await import('../src/app.js');
const { Order } = await import('../src/models/Order.model.js');
const { StaffUser } = await import('../src/models/StaffUser.model.js');
const { MagazineForm } = await import('../src/models/MagazineForm.model.js');
const { generateToken } = await import('../src/middlewares/auth.middleware.js');
const { proofPdf } = await import('./fixtures/proofPdf.js');
let mongo, server, base, designer, form;
const tokens = {};
before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  form = await MagazineForm.create({ title: 'Kanban transitions', slug: 'kanban-transitions', price: 50000 });
  for (const role of ['designer', 'manager']) {
    const user = await StaffUser.create({ name: role, email: `${role}@kanban.test`, role, passwordHash: 'unused' });
    tokens[role] = await generateToken(user, { verifiedAt: new Date() });
    if (role === 'designer') designer = user;
  }
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => { await Order.deleteMany({}); });
async function request(path, role = 'designer', body, method = body === undefined ? 'GET' : 'POST') {
  const multipart = body instanceof FormData;
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${tokens[role]}`, ...(!multipart ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
async function createOrder(status, extra = {}) {
  return Order.create({ submissionId: String(new mongoose.Types.ObjectId()), formId: form._id, formTitle: form.title,
    clientName: 'Kanban customer', clientWhatsApp: 'test', assignedDesigner: designer._id, status, ...extra });
}
async function assertColumn(order, expected) {
  const membership = [];
  for (const column of ['new', 'manager', 'client', 'completed']) {
    const result = await request(`/designer/orders?column=${column}&search=Kanban&limit=100`);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    if (result.data.orders.some(row => row._id === String(order._id))) membership.push(column);
  }
  assert.deepEqual(membership, [expected], `Order must appear in exactly ${expected}`);
}

for (const source of ['manager', 'client']) test(`${source} corrections keep their column through design, hold and resubmission until released`, async () => {
  const order = await createOrder('revision_requested', { currentDraftVersion: 1,
    draftVersions: [{ versionNumber: 1 }],
    revisionRequests: [{ roundNumber: 1, draftVersionNumber: 1, source, requestedBy: { type: source }, items: [{ text: 'Correct the date' }] }],
  });
  await assertColumn(order, source);
  assert.equal((await request(`/designer/orders/${order._id}/start-design`, 'designer', {})).status, 200);
  await assertColumn(order, source);
  assert.equal((await request(`/manager/orders/${order._id}/hold`, 'manager', { action: 'hold', reason: 'Waiting for details' })).status, 200);
  await assertColumn(order, source);
  assert.equal((await request(`/manager/orders/${order._id}/hold`, 'manager', { action: 'resume' })).status, 200);
  const revision = order.revisionRequests[0];
  assert.equal((await request(`/designer/orders/${order._id}/returns/${revision._id}/items/${revision.items[0]._id}`, 'designer', { response: 'Date corrected' }, 'PATCH')).status, 200);
  const upload = new FormData();
  upload.append('draftFile', new Blob([proofPdf(1)], { type: 'application/pdf' }), 'corrected.pdf');
  upload.append('expectedVersion', '1');
  upload.append('revisionRequestId', String(revision._id));
  upload.append('verifyAll', 'true');
  const uploaded = await request(`/designer/orders/${order._id}/upload-draft`, 'designer', upload);
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
  assert.equal(uploaded.data.order.status, 'draft_manager_review');
  await assertColumn(order, source);
  const released = await request(`/manager/orders/${order._id}/review-draft`, 'manager', { action: 'release_to_client', expectedVersion: 2 });
  assert.equal(released.status, 200, JSON.stringify(released.data));
  await assertColumn(order, 'new');
});

test('holding a completed design preserves its column and repeated holds preserve the resume stage', async () => {
  const order = await createOrder('printing_in_progress');
  for (let attempt = 0; attempt < 2; attempt++) {
    const held = await request(`/manager/orders/${order._id}/hold`, 'manager', { action: 'hold', reason: 'Printer paused' });
    assert.equal(held.status, 200);
    assert.equal(held.data.order.previousStatusBeforeHold, 'printing_in_progress');
  }
  await assertColumn(order, 'completed');
  const resumed = await request(`/manager/orders/${order._id}/hold`, 'manager', { action: 'resume' });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.order.status, 'printing_in_progress');
});

test('manager hold filters stay within their selected phase', async () => {
  const rows = {};
  for (const [phase, previousStatusBeforeHold] of [['pre_design', 'awaiting_payment'], ['design_phase', 'in_design'], ['post_design', 'printing_sent']]) {
    rows[phase] = await createOrder('on_hold', { previousStatusBeforeHold });
  }
  for (const [phase, order] of Object.entries(rows)) {
    const result = await request(`/manager/orders?phase=${phase}&status=on_hold&scope=all`, 'manager');
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.orders.map(row => row._id), [String(order._id)]);
    assert.equal(result.data.statusCounts.on_hold, 1);
  }
});

test('starting design rejects a stage where no update can be made', async () => {
  const order = await createOrder('client_review');
  const result = await request(`/designer/orders/${order._id}/start-design`, 'designer', {});
  assert.equal(result.status, 409);
  assert.equal((await Order.findById(order._id)).status, 'client_review');
});

test('each stage and its held counterpart appear once; resolved returns do not claim new work', async () => {
  for (const status of ['assigned', 'in_design', 'draft_manager_review', 'client_review', 'client_approved', 'print_document_prep',
    'print_manager_review', 'printing_sent', 'printing_in_progress', 'printing_completed', 'dispatched', 'delivered', 'closed']) {
    const completed = !['assigned', 'in_design', 'draft_manager_review', 'client_review'].includes(status);
    for (const held of [false, true]) {
      const order = await createOrder(held ? 'on_hold' : status, { previousStatusBeforeHold: held ? status : undefined,
        revisionRequests: [{ roundNumber: 1, draftVersionNumber: 1, source: 'client', status: 'resolved', requestedBy: { type: 'client' } }],
      });
      await assertColumn(order, completed ? 'completed' : 'new');
    }
  }
});

test('resuming an order without a valid previous stage does not invent a design transition', async () => {
  for (const previousStatusBeforeHold of [undefined, 'on_hold']) {
    const order = await createOrder('on_hold', { previousStatusBeforeHold });
    const result = await request(`/manager/orders/${order._id}/hold`, 'manager', { action: 'resume' });
    assert.equal(result.status, 409);
    assert.equal((await Order.findById(order._id)).status, 'on_hold');
  }
});
