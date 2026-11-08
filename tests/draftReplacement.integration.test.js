import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Order } from '../src/models/Order.model.js';
import { MediaJob, ProofPage } from '../src/models/Media.model.js';
import { DraftUpload } from '../src/models/DraftUpload.model.js';
import { saveDraftPdf } from '../src/services/draftFileService.js';
import { enqueueProof } from '../src/services/proofReaderService.js';
import { cleanSupersededDrafts } from '../src/services/draftReplacementService.js';
import { cleanExpiredOrders } from '../src/services/orderRetentionService.js';
import { privateDraftStorage } from '../src/services/privateDraftStorage.js';
import { proofPdf } from './fixtures/proofPdf.js';

let mongo;
const oid = () => new mongoose.Types.ObjectId();
const now = () => new Date();
const drained = () => new Date(Date.now() + 6 * 60000);
before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => { for (const collection of await mongoose.connection.db.collections()) await collection.deleteMany({}); });
async function fixture(extra = {}) {
  const id = oid();
  const first = await saveDraftPdf({ originalname: 'first.pdf', buffer: proofPdf() }, id, 1);
  const latest = await saveDraftPdf({ originalname: 'latest.pdf', buffer: proofPdf(2) }, id, 2);
  const order = await Order.create({ _id: id, submissionId: String(id), formId: oid(), clientName: 'Test', clientWhatsApp: 'test', status: 'draft_manager_review', currentDraftVersion: 2,
    draftVersions: [{ versionNumber: 1, assetId: first }, { versionNumber: 2, assetId: latest }],
    revisionRequests: [{ roundNumber: 1, draftVersionNumber: 1, source: 'manager', requestedBy: { type: 'manager' }, items: [{ text: 'Correct the date' }] }], ...extra });
  return { order, first, latest };
}
const file = id => mongoose.connection.db.collection('draftFiles.files').findOne({ _id: id });

test('existing history is replaced, then old PDF and previews are erased while current PDF and correction notes survive', async () => {
  const { order, first, latest } = await fixture();
  const image = oid();
  await mongoose.connection.db.collection('proofPages.files').insertOne({ _id: image });
  await mongoose.connection.db.collection('proofPages.chunks').insertOne({ files_id: image, n: 0, data: Buffer.from('image') });
  await ProofPage.create({ orderId: order._id, version: 1, page: 1, imageId: image });
  await MediaJob.create({ _id: 'old-proof', orderId: order._id, version: 1, kind: 'proof', state: 'ready', outputId: String(image) });
  const upload = await DraftUpload.create({ orderId: order._id, staffId: oid(), assetId: first, state: 'finalizing' });
  await Order.updateOne({ _id: order._id }, { $set: { 'draftVersions.0.uploadSessionId': upload._id } });
  assert.deepEqual(await cleanSupersededDrafts({ now: now() }), { queued: 1, deleted: 0, pending: 1, failed: 0 });
  const saved = await Order.findById(order._id);
  assert.deepEqual(saved.draftVersions.map(v => v.versionNumber), [2]);
  assert.equal(saved.toJSON().supersededDrafts, undefined);
  assert.equal(saved.revisionRequests[0].items[0].text, 'Correct the date');
  assert.ok(await file(first));
  assert.equal(await enqueueProof(order._id, 1), null);
  const stale = await Order.findById(order._id);
  assert.equal((await cleanSupersededDrafts({ now: drained() })).deleted, 1);
  stale.holdReason = 'stale'; await assert.rejects(stale.save(), { name: 'VersionError' });
  assert.equal(await file(first), null); assert.ok(await file(latest));
  assert.equal(await ProofPage.countDocuments(), 0); assert.equal(await MediaJob.countDocuments(), 0);
  assert.equal(await mongoose.connection.db.collection('proofPages.chunks').countDocuments(), 0);
  assert.equal((await DraftUpload.findById(upload._id)).state, 'complete');
  assert.equal((await Order.findById(order._id)).supersededDrafts.length, 0);
  assert.deepEqual(await cleanSupersededDrafts({ now: drained() }), { queued: 0, deleted: 0, pending: 0, failed: 0 });
});

test('missing or truncated latest PDF preserves old versions and bytes', async () => {
  const { order, first, latest } = await fixture();
  await mongoose.connection.db.collection('draftFiles.chunks').deleteMany({ files_id: latest });
  assert.equal((await cleanSupersededDrafts()).failed, 1);
  assert.equal((await Order.findById(order._id)).draftVersions.length, 2); assert.ok(await file(first));
});

test('backfill does not discard a version newer than the recorded current version', async () => {
  const { order, first, latest } = await fixture({ currentDraftVersion: 1 });
  assert.equal((await cleanSupersededDrafts()).failed, 1);
  assert.equal((await Order.findById(order._id)).draftVersions.length, 2);
  assert.ok(await file(first)); assert.ok(await file(latest));
});

test('active proof worker drains before its source and output are removed', async () => {
  const { order, first } = await fixture();
  await cleanSupersededDrafts();
  await MediaJob.create({ _id: 'working', orderId: order._id, version: 1, kind: 'proof', state: 'running', leaseUntil: new Date(Date.now() + 60000) });
  assert.equal((await cleanSupersededDrafts({ now: drained() })).pending, 1); assert.ok(await file(first));
  await MediaJob.updateOne({ _id: 'working' }, { state: 'ready' });
  assert.equal((await cleanSupersededDrafts({ now: drained() })).deleted, 1); assert.equal(await file(first), null);
});

test('active print file and files referenced by another order remain stored', async () => {
  const { order, first } = await fixture();
  await Order.updateOne({ _id: order._id }, { $set: { 'printDocument.url': `/api/public/drafts/${first}` } });
  await cleanSupersededDrafts(); await cleanSupersededDrafts({ now: drained() });
  assert.ok(await file(first));
  const second = await fixture();
  await Order.updateOne({ _id: order._id }, { $set: { 'draftVersions.0.fileUrl': `/api/public/drafts/${second.first}` } });
  await cleanSupersededDrafts(); await cleanSupersededDrafts({ now: drained() });
  assert.ok(await file(second.first));
});

test('storage failure retains cleanup references; concurrent retry removes one copy only', async () => {
  const { order } = await fixture();
  await Order.updateOne({ _id: order._id }, { $set: { 'draftVersions.0.storageProvider': 'blob', 'draftVersions.0.blobPath': 'tinzel/drafts/old.pdf' }, $unset: { 'draftVersions.0.assetId': '' } });
  await cleanSupersededDrafts();
  let attempts = 0;
  const remove = mock.method(privateDraftStorage, 'remove', async () => { attempts++; throw new Error('offline'); });
  try {
    assert.equal((await cleanSupersededDrafts({ now: drained() })).failed, 1);
    assert.equal((await Order.findById(order._id)).supersededDrafts.length, 1);
    remove.mock.mockImplementation(async () => { attempts++; });
    const results = await Promise.all([cleanSupersededDrafts({ now: drained() }), cleanSupersededDrafts({ now: drained() })]);
    assert.equal(results.reduce((sum, result) => sum + result.deleted, 0), 1); assert.equal(attempts, 2);
  } finally { remove.mock.restore(); }
});

test('whole submission deletion includes superseded files and waits for replacement cleanup', async () => {
  const { order, first, latest } = await fixture();
  await cleanSupersededDrafts();
  await Order.collection.updateOne({ _id: order._id }, { $set: { retentionDeletingAt: new Date(Date.now() - 600000), draftCleanupLeaseUntil: new Date(Date.now() + 600000) } });
  assert.equal((await cleanExpiredOrders()).deleted, 0);
  await Order.collection.updateOne({ _id: order._id }, { $unset: { draftCleanupLeaseUntil: '' } });
  assert.equal((await cleanExpiredOrders()).deleted, 1);
  assert.equal(await file(first), null); assert.equal(await file(latest), null);
});
