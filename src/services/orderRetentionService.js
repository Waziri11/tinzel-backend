import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { del } from '@vercel/blob';
import { Order } from '../models/Order.model.js';
import { SystemConfig } from '../models/SystemConfig.model.js';
import { MediaAsset, MediaJob, UploadSession, ProofPage, MediaDownloadTicket } from '../models/Media.model.js';
import { DraftUpload } from '../models/DraftUpload.model.js';
import { ProofAttachment } from '../models/ProofAttachment.model.js';
import { Notification } from '../models/Notification.model.js';
import { AuditLog } from '../models/AuditLog.model.js';
import { AccessSession, AccessChallenge } from '../models/AccessSession.model.js';
import { SecurityEvent, SecurityEventDelivery } from '../models/SecurityEvent.model.js';
import { privateDraftStorage } from './privateDraftStorage.js';
import { blobPath } from './mediaSessionService.js';
import { RETENTION_KEY, DEFAULT_RETENTION_DAYS, TERMINAL_STATUSES, validRetentionDays } from './orderRetentionPolicy.js';

const DAY = 86400000;
// Drain requests and worker leases before removing bytes. Hidden records retain all
// storage references until every deletion succeeds, so failures can safely retry.
const DRAIN_MS = 5 * 60000;
const ids = values => [...new Set(values.filter(Boolean).map(String))].map(value => new mongoose.Types.ObjectId(value));
async function removeGridFiles(bucket, values) {
  const fileIds = ids(values);
  if (!fileIds.length) return;
  const db = mongoose.connection.db;
  await db.collection(`${bucket}.chunks`).deleteMany({ files_id: { $in: fileIds } });
  await db.collection(`${bucket}.files`).deleteMany({ _id: { $in: fileIds } });
}
export async function removeLegacyFile(url) {
  if (!url) return;
  if (!/^\/uploads\/(photos|drafts|print|previews)\/[a-zA-Z0-9._-]+$/.test(url)) throw new Error('Unrecognized legacy submission file');
  await unlink(path.resolve('uploads', url.slice('/uploads/'.length))).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
const fileId = (url, type) => String(url || '').match(new RegExp(`^/api/public/${type}/([a-f0-9]{24})$`, 'i'))?.[1];

async function purgeFilesAndRecords(order, owner) {
  const db = mongoose.connection.db, orderId = order._id, orderKey = String(orderId);
  const sessions = await UploadSession.find({ $or: [{ orderId }, ...(order.mediaSessionId ? [{ _id: order.mediaSessionId }] : [])] }).lean();
  const sessionIds = sessions.map(s => s._id);
  const photoIds = new Set((order.uploadedPhotos || []).flatMap(p => [p.assetId, fileId(p.url, 'photos'), fileId(p.url, 'media/assets')]).filter(Boolean));
  for (const session of sessions) for (const entry of session.entries) photoIds.add(entry._id);
  const assets = await MediaAsset.find({ $or: [{ _id: { $in: [...photoIds] } }, { sessionId: { $in: sessionIds } }] }).lean();
  for (const asset of assets) photoIds.add(asset._id);
  const jobFilter = { $or: [{ orderId }, { assetId: { $in: [...photoIds] } }] };
  // Stop queued work; running work is allowed to drain before removing its output.
  await MediaJob.updateMany({ ...jobFilter, state: { $ne: 'running' } }, { $set: { state: 'expired' } });
  if (await MediaJob.exists({ ...jobFilter, state: 'running', leaseUntil: { $gt: new Date() } })) return false;
  const uploads = await DraftUpload.find({ orderId }).lean();
  if (uploads.some(u => u.provider === 'blob' && u.state !== 'complete' && u.expiresAt > new Date())) return false;
  const [jobs, pages, attachments] = await Promise.all([
    MediaJob.find(jobFilter).lean(), ProofPage.find({ orderId }).lean(), ProofAttachment.find({ orderId }).lean(),
  ]);
  if (attachments.some(a => a.processingUntil > new Date())) return false;
  const originals = new Set(assets.filter(a => a.provider === 'blob').map(a => a.blobPath || blobPath(a._id)));
  for (const session of sessions) for (const entry of session.entries) if (entry.provider === 'blob') originals.add(blobPath(entry._id));
  for (const pathname of originals) await del(pathname);
  const drafts = [...(order.draftVersions || []), ...(order.supersededDrafts || [])];
  const printUrl = order.printDocument?.url;
  const privatePaths = new Set([...drafts.filter(d => d.storageProvider === 'blob').map(d => d.blobPath), ...uploads.filter(u => u.provider === 'blob').map(u => u.blobPath)]);
  if (printUrl?.startsWith('tinzel/drafts/')) privatePaths.add(printUrl);
  for (const pathname of privatePaths) {
    if (!pathname) throw new Error('Missing private storage reference');
    await privateDraftStorage.remove(pathname);
  }
  const outputs = kind => jobs.filter(j => j.kind === kind).flatMap(j => [j.outputId, ...(j.outputIds || [])]);
  const extraDrafts = await db.collection('draftFiles.files').find({ 'metadata.orderId': orderKey }, { projection: { _id: 1 } }).toArray();
  const audioFiles = await db.collection('revisionAudio.files').find({ 'metadata.orderId': orderKey }, { projection: { _id: 1 } }).toArray();
  await removeGridFiles('revisionAudio', audioFiles.map(file => file._id));
  await removeGridFiles('orderPhotos', [...photoIds]);
  await removeGridFiles('mediaDerivatives', [...assets.map(a => a.thumbnailId), ...outputs('preview')]);
  await removeGridFiles('draftFiles', [...drafts.map(d => d.assetId), ...drafts.map(d => fileId(d.fileUrl, 'drafts')), ...uploads.map(u => u.assetId), fileId(printUrl, 'drafts'), ...extraDrafts.map(d => d._id)]);
  await removeGridFiles('proofPages', [...pages.map(p => p.imageId), ...outputs('proof')]);
  await removeGridFiles('mediaArchives', outputs('archive'));
  await removeGridFiles('proofAttachments', attachments.flatMap(a => [a.imageId, a.thumbnailId]));
  const legacyFiles = [...(order.uploadedPhotos || []).flatMap(p => [p.url, p.thumbnailUrl]), ...drafts.flatMap(d => [d.fileUrl, ...(d.previewPages || [])]), printUrl].filter(u => u?.startsWith('/uploads/'));
  for (const url of new Set(legacyFiles)) await removeLegacyFile(url);
  // Keep the owning order and asset references until file deletion is complete.
  await db.collection('proofAttachmentUploads').deleteMany({ assetId: { $in: attachments.map(a => String(a._id)) } });
  await Promise.all([
    ProofAttachment.deleteMany({ orderId }), ProofPage.deleteMany({ orderId }), DraftUpload.deleteMany({ orderId }),
    MediaDownloadTicket.deleteMany({ orderId }), MediaJob.deleteMany(jobFilter), MediaAsset.deleteMany({ _id: { $in: [...photoIds] } }),
    UploadSession.deleteMany({ _id: { $in: sessionIds } }), Notification.deleteMany({ orderId }), AuditLog.deleteMany({ orderId }),
    AccessSession.deleteMany({ subjectId: orderKey, kind: { $ne: 'staff' } }), AccessChallenge.deleteMany({ subjectId: orderKey }),
    db.collection('printerinvitations').deleteMany({ orderId: orderKey }),
  ]);
  const events = await SecurityEvent.find({ orderId: orderKey }).select('eventId').lean();
  await SecurityEventDelivery.deleteMany({ _id: { $in: events.map(e => e.eventId) } });
  // Explicit retention erasure is the sole exception to append-only audit writes.
  await SecurityEvent.collection.deleteMany({ orderId: orderKey });
  await Order.collection.deleteOne({ _id: orderId, retentionOwner: owner });
  return true;
}

export async function cleanExpiredOrders({ limit = 10, now = new Date() } = {}) {
  const config = await SystemConfig.findOne({ key: RETENTION_KEY }).lean();
  const days = config ? config.value : DEFAULT_RETENTION_DAYS;
  if (!validRetentionDays(days)) throw new Error('Invalid magazine retention setting');
  const cutoff = new Date(+now - days * DAY);
  // Older orders have no completedAt: freeze their delivery date (or last update)
  // once, so subsequent reads/notifications cannot extend retention indefinitely.
  await Order.collection.updateMany({ status: { $in: TERMINAL_STATUSES }, completedAt: null, retentionDeletingAt: null }, [
    { $set: { completedAt: { $ifNull: ['$deliveryDetails.confirmedAt', '$updatedAt'] } } },
  ]);
  const candidates = await Order.collection.find({ $or: [
    { retentionDeletingAt: { $ne: null } },
    { status: { $in: TERMINAL_STATUSES }, completedAt: { $lte: cutoff } },
  ] }).sort({ retentionDeletingAt: -1, completedAt: 1 }).limit(limit).toArray();
  const result = { deleted: 0, pending: 0, failed: 0 };
  for (const candidate of candidates) {
    const owner = randomUUID();
    const order = await Order.collection.findOneAndUpdate({ _id: candidate._id, __v: candidate.__v, $and: [
      { $or: [{ retentionLeaseUntil: null }, { retentionLeaseUntil: { $lte: now } }] },
      { $or: [{ draftCleanupLeaseUntil: null }, { draftCleanupLeaseUntil: { $lte: now } }] },
      { $or: [{ retentionDeletingAt: { $ne: null } }, { status: { $in: TERMINAL_STATUSES }, completedAt: { $lte: cutoff } }] },
    ] }, { $set: { retentionDeletingAt: candidate.retentionDeletingAt || now, retentionOwner: owner, retentionLeaseUntil: new Date(+now + 10 * 60000) }, $inc: { __v: 1 } }, { returnDocument: 'after' });
    if (!order) continue;
    try {
      if (+now - +order.retentionDeletingAt < DRAIN_MS) { result.pending++; continue; }
      if (await purgeFilesAndRecords(order, owner)) result.deleted++; else result.pending++;
    } catch {
      // Do not log customer data, storage URLs, or discard the retry manifest.
      result.failed++;
    } finally {
      await Order.collection.updateOne({ _id: order._id, retentionOwner: owner }, { $unset: { retentionLeaseUntil: '', retentionOwner: '' } });
    }
  }
  return result;
}
