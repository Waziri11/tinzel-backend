import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Order } from '../src/models/Order.model.js';
import { SystemConfig } from '../src/models/SystemConfig.model.js';
import { MediaAsset, MediaJob, UploadSession, ProofPage, MediaDownloadTicket } from '../src/models/Media.model.js';
import { DraftUpload } from '../src/models/DraftUpload.model.js';
import { ProofAttachment } from '../src/models/ProofAttachment.model.js';
import { Notification } from '../src/models/Notification.model.js';
import { AuditLog } from '../src/models/AuditLog.model.js';
import { AccessSession, AccessChallenge } from '../src/models/AccessSession.model.js';
import { SecurityEvent, SecurityEventDelivery } from '../src/models/SecurityEvent.model.js';
import { cleanExpiredOrders, removeLegacyFile } from '../src/services/orderRetentionService.js';
import { privateDraftStorage } from '../src/services/privateDraftStorage.js';
import { RETENTION_KEY, validRetentionDays } from '../src/services/orderRetentionPolicy.js';
import { designerColumnFilter } from '../src/services/designerBoardService.js';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DAY = 86400000, now = new Date('2026-11-07T12:00:00Z'), drained = new Date(+now + 6 * 60000);
const oid = () => new mongoose.Types.ObjectId();
let mongo;
before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => { for (const collection of await mongoose.connection.db.collections()) await collection.deleteMany({}); });
async function order(status = 'closed', age = 8, extra = {}) {
  const doc = await Order.create({ submissionId: String(oid()), formId: oid(), clientName: 'Test', clientWhatsApp: 'test', status, ...extra });
  await Order.collection.updateOne({ _id: doc._id }, { $set: { completedAt: new Date(+now - age * DAY), updatedAt: new Date(+now - age * DAY) } });
  return Order.findById(doc._id);
}
async function bytes(bucket, id = oid()) {
  const db = mongoose.connection.db;
  await db.collection(`${bucket}.files`).insertOne({ _id: id, filename: 'test' });
  await db.collection(`${bucket}.chunks`).insertOne({ files_id: id, n: 0, data: Buffer.from('private') });
  return id;
}
test('default seven days preserves active/recent orders and uses an inclusive cutoff', async () => {
  const active = await order('in_design', 60), recent = await order('closed', 6), boundary = await order('closed', 7);
  assert.deepEqual(await cleanExpiredOrders({ now }), { deleted: 0, pending: 1, failed: 0 });
  assert.ok(await Order.findById(active._id)); assert.ok(await Order.findById(recent._id));
  assert.equal(await Order.findById(boundary._id), null);
  assert.equal(await Order.countDocuments(), 2);
  assert.equal((await Order.aggregate([{ $count: 'total' }]))[0].total, 2);
  assert.equal((await cleanExpiredOrders({ now: drained })).deleted, 1);
  assert.equal(await Order.collection.countDocuments(), 2);
});
test('custom interval, legacy completion date, and reopened orders', async () => {
  await SystemConfig.create({ key: RETENTION_KEY, value: 30 });
  const old = await order('closed', 20);
  assert.equal((await cleanExpiredOrders({ now })).pending, 0);
  await SystemConfig.updateOne({ key: RETENTION_KEY }, { value: 3 });
  await Order.collection.updateOne({ _id: old._id }, { $unset: { completedAt: '' } });
  assert.equal((await cleanExpiredOrders({ now })).pending, 1);
  const reopened = await order('closed', 50);
  reopened.status = 'in_design'; await reopened.save();
  assert.equal(reopened.completedAt, undefined);
  await cleanExpiredOrders({ now: drained });
  assert.ok(await Order.findById(reopened._id));
});
test('completion timestamp is stable and stale saves cannot undo a deletion claim', async () => {
  const item = await order('in_design'); item.status = 'closed'; item.completedAt = undefined; await item.save();
  const completed = +item.completedAt; item.holdReason = 'note'; await item.save(); assert.equal(+item.completedAt, completed);
  const stale = await order(); await cleanExpiredOrders({ now });
  stale.status = 'in_design'; await assert.rejects(stale.save(), { name: 'VersionError' });
  assert.equal((await Order.updateOne({ _id: stale._id }, { status: 'in_design' })).matchedCount, 0);
});
test('erases all related GridFS bytes, records, access and submission history; keeps unrelated data', async () => {
  const photo = await bytes('orderPhotos'), thumb = await bytes('mediaDerivatives'), draft = await bytes('draftFiles');
  const proof = await bytes('proofPages'), archive = await bytes('mediaArchives'), image = await bytes('proofAttachments'), tiny = await bytes('proofAttachments');
  const unrelated = await bytes('orderPhotos');
  const doc = await order('closed', 8, { mediaSessionId: 'session', uploadedPhotos: [{ assetId: String(photo) }], draftVersions: [{ versionNumber: 1, assetId: draft }] });
  const orderId = doc._id, key = String(orderId), attachmentId = oid();
  await UploadSession.create({ _id: 'session', orderId, entries: [{ _id: String(photo), provider: 'gridfs' }], finalization: { private: 'answers' } });
  await MediaAsset.create({ _id: String(photo), sessionId: 'session', thumbnailId: String(thumb) });
  await MediaJob.create({ _id: 'archive', orderId, kind: 'archive', outputId: String(archive), state: 'ready' });
  await ProofPage.create({ orderId, version: 1, page: 1, imageId: proof });
  await DraftUpload.create({ orderId, staffId: oid(), assetId: draft });
  await ProofAttachment.create({ _id: attachmentId, orderId, imageId: image, thumbnailId: tiny });
  await mongoose.connection.db.collection('proofAttachmentUploads').insertOne({ assetId: String(attachmentId), bytes: 'private' });
  await MediaDownloadTicket.create({ _id: 'ticket', orderId });
  await Notification.create({ orderId, recipient: 'test', message: 'private', channel: 'in_system' });
  await AuditLog.create({ orderId, actor: { type: 'client' }, action: 'test' });
  await AccessSession.create({ _id: 'session', subjectId: key, kind: 'client' });
  await AccessChallenge.create({ _id: 'challenge', subjectId: key });
  await SecurityEvent.create({ eventId: 'event', orderId: key, action: 'test', expiresAt: new Date(+now + DAY) });
  await SecurityEventDelivery.create({ _id: 'event', expiresAt: new Date(+now + DAY) });
  await mongoose.connection.db.collection('printerinvitations').insertOne({ orderId: key });
  await cleanExpiredOrders({ now });
  assert.equal((await cleanExpiredOrders({ now: drained })).deleted, 1);
  for (const model of [Order, UploadSession, MediaAsset, MediaJob, ProofPage, DraftUpload, ProofAttachment, MediaDownloadTicket, Notification, AuditLog, AccessSession, AccessChallenge, SecurityEvent, SecurityEventDelivery]) assert.equal(await model.collection.countDocuments(), 0, model.modelName);
  for (const bucket of ['orderPhotos', 'mediaDerivatives', 'draftFiles', 'proofPages', 'mediaArchives', 'proofAttachments']) {
    assert.equal(await mongoose.connection.db.collection(`${bucket}.files`).countDocuments(), bucket === 'orderPhotos' ? 1 : 0, bucket);
    assert.equal(await mongoose.connection.db.collection(`${bucket}.chunks`).countDocuments(), bucket === 'orderPhotos' ? 1 : 0, bucket);
  }
  assert.ok(await mongoose.connection.db.collection('orderPhotos.files').findOne({ _id: unrelated }));
  assert.equal(await mongoose.connection.db.collection('proofAttachmentUploads').countDocuments(), 0);
  assert.equal(await mongoose.connection.db.collection('printerinvitations').countDocuments(), 0);
});
test('private storage failures retain references and retry; concurrent workers delete only once', async () => {
  const doc = await order('closed', 8, { draftVersions: [{ versionNumber: 1, storageProvider: 'blob', blobPath: 'tinzel/drafts/test.pdf' }] });
  const original = privateDraftStorage.remove; let removed = [];
  try {
    privateDraftStorage.remove = async () => { throw new Error('offline'); };
    await cleanExpiredOrders({ now });
    assert.equal((await cleanExpiredOrders({ now: drained })).failed, 1);
    assert.equal((await Order.collection.findOne({ _id: doc._id })).draftVersions.length, 1);
    privateDraftStorage.remove = async value => { removed.push(value); };
    const results = await Promise.all([cleanExpiredOrders({ now: drained }), cleanExpiredOrders({ now: drained })]);
    assert.equal(results.reduce((n, r) => n + r.deleted, 0), 1);
    assert.deepEqual(removed, ['tinzel/drafts/test.pdf']);
  } finally { privateDraftStorage.remove = original; }
});
test('deletion waits for active media jobs', async () => {
  const doc = await order();
  await MediaJob.create({ _id: 'running', kind: 'proof', orderId: doc._id, state: 'running', leaseUntil: new Date(Date.now() + DAY) });
  await cleanExpiredOrders({ now }); assert.equal((await cleanExpiredOrders({ now: drained })).pending, 1);
  await MediaJob.updateOne({ _id: 'running' }, { state: 'ready' });
  assert.equal((await cleanExpiredOrders({ now: drained })).deleted, 1);
});
test('legacy files are removed safely and idempotently', async () => {
  const cwd = process.cwd(), folder = await mkdtemp(path.join(tmpdir(), 'tinzel-retention-'));
  const { mkdir } = await import('node:fs/promises');
  try {
    process.chdir(folder); await mkdir('uploads/photos', { recursive: true }); await writeFile('uploads/photos/test.jpg', 'private');
    await removeLegacyFile('/uploads/photos/test.jpg'); await assert.rejects(access('uploads/photos/test.jpg'));
    await removeLegacyFile('/uploads/photos/test.jpg'); await assert.rejects(removeLegacyFile('/uploads/photos/../../outside'));
  } finally { process.chdir(cwd); await rm(folder, { recursive: true, force: true }); }
});
test('retention rejects unsafe values', () => {
  for (const value of [0, -1, 1.5, 3651, null, '7', NaN, Infinity]) assert.equal(validRetentionDays(value), false);
  assert.equal(validRetentionDays(7), true);
});
test('board separates latest return source and preserves review and completed designs', async () => {
  const manager = await order('revision_requested', 0, { revisionRequests: [{ roundNumber: 1, draftVersionNumber: 1, source: 'client', requestedBy: { type: 'client' } }, { roundNumber: 2, draftVersionNumber: 2, source: 'manager', requestedBy: { type: 'manager' } }] });
  const client = await order('revision_requested', 0, { revisionRequests: [{ roundNumber: 1, draftVersionNumber: 1, source: 'client', requestedBy: { type: 'client' } }] });
  await order('assigned', 0); await order('client_review', 0); await order('client_approved', 0);
  assert.deepEqual((await Order.find(designerColumnFilter('manager'))).map(o => String(o._id)), [String(manager._id)]);
  assert.deepEqual((await Order.find(designerColumnFilter('client'))).map(o => String(o._id)), [String(client._id)]);
  assert.equal(await Order.countDocuments(designerColumnFilter('new')), 2);
  assert.equal(await Order.countDocuments(designerColumnFilter('completed')), 1);
});
