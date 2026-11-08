import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { Order } from '../models/Order.model.js';
import { MediaJob, ProofPage } from '../models/Media.model.js';
import { DraftUpload } from '../models/DraftUpload.model.js';
import { draftRangeSource } from './draftFileService.js';
import { privateDraftStorage } from './privateDraftStorage.js';
import { keepLatestDraft } from './draftReplacementPolicy.js';
import { removeLegacyFile } from './orderRetentionService.js';

export const DRAFT_REPLACEMENT_DRAIN_MS = 5 * 60000;
const draftId = draft => draft.assetId || String(draft.fileUrl || '').match(/^\/api\/public\/drafts\/([a-f0-9]{24})$/i)?.[1];

// Existing history is pruned only when the current PDF has complete stored bytes.
export async function assertStoredDraft(draft) {
  const id = draftId(draft);
  if (id) {
    const db = mongoose.connection.db, objectId = new mongoose.Types.ObjectId(id);
    const file = await db.collection('draftFiles.files').findOne({ _id: objectId });
    if (!file || !file.length || !file.chunkSize) throw new Error('Current magazine storage is incomplete');
    const [parts] = await db.collection('draftFiles.chunks').aggregate([
      { $match: { files_id: objectId } },
      { $group: { _id: null, count: { $sum: 1 }, bytes: { $sum: { $binarySize: '$data' } }, first: { $min: '$n' }, last: { $max: '$n' } } },
    ]).toArray();
    const count = Math.ceil(file.length / file.chunkSize);
    if (parts?.bytes !== file.length || parts.count !== count || parts.first !== 0 || parts.last !== count - 1) throw new Error('Current magazine storage is incomplete');
  }
  const source = await draftRangeSource(id ? { ...draft, assetId: id } : draft);
  if (draft.size > 0 && source.length !== draft.size) throw new Error('Current magazine storage is incomplete');
  const pieces = [];
  for await (const piece of source.read(0, Math.min(5, source.length), AbortSignal.timeout(10000))) pieces.push(piece);
  if (Buffer.concat(pieces).toString() !== '%PDF-') throw new Error('Current magazine PDF is invalid');
}

async function referencedDraft({ id, blobPath, fileUrl }) {
  const references = [
    ...(id ? [{ 'draftVersions.assetId': id }, { 'draftVersions.fileUrl': `/api/public/drafts/${id}` }, { 'printDocument.url': `/api/public/drafts/${id}` }] : []),
    ...(blobPath ? [{ 'draftVersions.blobPath': blobPath }, { 'printDocument.url': blobPath }] : []),
    ...(fileUrl ? [{ 'draftVersions.fileUrl': fileUrl }, { 'printDocument.url': fileUrl }] : []),
  ];
  return references.length && await Order.collection.findOne({ $or: references }, { projection: { _id: 1 } });
}

async function removeGrid(bucket, ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))].map(id => new mongoose.Types.ObjectId(id));
  if (!unique.length) return;
  await mongoose.connection.db.collection(`${bucket}.chunks`).deleteMany({ files_id: { $in: unique } });
  await mongoose.connection.db.collection(`${bucket}.files`).deleteMany({ _id: { $in: unique } });
}

export async function cleanSupersededDrafts({ limit = 10, now = new Date() } = {}) {
  const result = { queued: 0, deleted: 0, pending: 0, failed: 0 };
  // This also applies the latest-version policy to magazines saved before rollout.
  for (const order of await Order.find({ 'draftVersions.1': { $exists: true } }).limit(limit)) {
    try {
      const current = order.draftVersions.find(draft => draft.versionNumber === order.currentDraftVersion);
      if (!current || order.draftVersions.some(draft => draft.versionNumber > current.versionNumber)) { result.failed++; continue; }
      await assertStoredDraft(current.toObject());
      if (keepLatestDraft(order, now)) { await order.save(); result.queued++; }
    } catch { result.failed++; }
  }
  const rows = await Order.find({ 'supersededDrafts.0': { $exists: true } }).select('_id').limit(limit).lean();
  for (const row of rows) {
    const owner = randomUUID();
    const order = await Order.collection.findOneAndUpdate({ _id: row._id, retentionDeletingAt: null,
      $or: [{ draftCleanupLeaseUntil: null }, { draftCleanupLeaseUntil: { $lte: now } }],
    }, { $set: { draftCleanupOwner: owner, draftCleanupLeaseUntil: new Date(+now + 10 * 60000) } }, { returnDocument: 'after' });
    if (!order) continue;
    try {
      const current = order.draftVersions.find(draft => draft.versionNumber === order.currentDraftVersion);
      if (!current) throw new Error('Current magazine is unavailable');
      await assertStoredDraft(current);
      for (const old of order.supersededDrafts || []) {
        if (old.versionNumber >= order.currentDraftVersion) continue;
        // Renew ownership before each deletion; whole-submission cleanup waits for it.
        const renewed = await Order.collection.updateOne({ _id: order._id, draftCleanupOwner: owner,
          draftCleanupLeaseUntil: { $gt: new Date() }, retentionDeletingAt: null,
        }, { $set: { draftCleanupLeaseUntil: new Date(Date.now() + 10 * 60000) } });
        if (!renewed.matchedCount) break;
        const jobs = { orderId: order._id, kind: 'proof', version: old.versionNumber };
        await MediaJob.updateMany({ ...jobs, state: { $ne: 'running' } }, { $set: { state: 'expired', requested: false } });
        if (!old.supersededAt || +now - +old.supersededAt < DRAFT_REPLACEMENT_DRAIN_MS ||
          await MediaJob.exists({ ...jobs, state: 'running', leaseUntil: { $gt: new Date() } })) { result.pending++; continue; }
        await MediaJob.updateMany(jobs, { $set: { state: 'expired', requested: false } });
        const [pages, outputs] = await Promise.all([
          ProofPage.find({ orderId: order._id, version: old.versionNumber }).select('imageId').lean(),
          MediaJob.find(jobs).select('outputId outputIds').lean(),
        ]);
        const rawId = draftId(old), id = rawId ? new mongoose.Types.ObjectId(rawId) : null;
        if (!await referencedDraft({ id, blobPath: old.blobPath, fileUrl: old.fileUrl })) {
          if (old.storageProvider === 'blob' && old.blobPath) await privateDraftStorage.remove(old.blobPath).catch(error => { if (error.status !== 404) throw error; });
          if (id) await removeGrid('draftFiles', [id]);
          if (old.fileUrl?.startsWith('/uploads/')) await removeLegacyFile(old.fileUrl);
        }
        await removeGrid('proofPages', [...pages.map(page => page.imageId), ...outputs.flatMap(job => [job.outputId, ...(job.outputIds || [])])]);
        for (const file of old.previewPages || []) if (file.startsWith('/uploads/')) await removeLegacyFile(file);
        await ProofPage.deleteMany({ orderId: order._id, version: old.versionNumber });
        await MediaJob.deleteMany(jobs);
        if (old.uploadSessionId) await DraftUpload.updateOne({ _id: old.uploadSessionId }, { $set: { state: 'complete', version: old.versionNumber } });
        await Order.collection.updateOne({ _id: order._id, draftCleanupOwner: owner }, {
          $pull: { supersededDrafts: { _id: old._id } }, $inc: { __v: 1 },
        });
        result.deleted++;
      }
    } catch { result.failed++; }
    finally {
      await Order.collection.updateOne({ _id: order._id, draftCleanupOwner: owner }, { $unset: { draftCleanupOwner: '', draftCleanupLeaseUntil: '' } });
    }
  }
  return result;
}
