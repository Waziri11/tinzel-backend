import { runProofJobs } from './proofWorkerService.js';
import { cleanExpiredDraftUploads } from './draftUploadService.js';
import mongoose from 'mongoose';
import { randomUUID, createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { ZipArchive } from 'archiver';
import { del } from '@vercel/blob';
import { MediaAsset, MediaJob, UploadSession, ProofPage } from '../models/Media.model.js';
import { Order } from '../models/Order.model.js';
import { digest, blobPath } from './mediaSessionService.js';
import { openAssetStream } from './mediaReadService.js';
import { photoArchiveEntries } from '../utils/photoArchive.js';
import { mediaError } from './mediaErrors.js';

const bucket = (name) => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: name });

export async function enqueueArchive(order, folder) {
  const photos = order.uploadedPhotos.filter((p) => p.folderName === folder || (!p.folderName && folder === 'General Photos'));
  if (!photos.length) throw mediaError(404, 'This folder has no photos');
  const id = `archive:${digest(JSON.stringify([String(order._id), folder, photos.map((p) => [p.url, p.originalName, p.size])]))}`;
  const job = await MediaJob.findOneAndUpdate({ _id: id }, { $setOnInsert: { kind: 'archive', orderId: order._id, folder } }, { upsert: true, returnDocument: 'after' }).lean();
  if (job.state === 'expired') return MediaJob.findOneAndUpdate({ _id: id }, { $set: { state: 'queued', attempts: 0, runAfter: new Date() } }, { returnDocument: 'after' }).lean();
  return job;
}

export async function cleanDerivedMedia() {
  const cutoff = new Date(Date.now() - (Number(process.env.MEDIA_ARCHIVE_TTL_HOURS) || 24) * 3600000);
  await MediaJob.updateMany({ kind: 'archive', state: 'ready', completedAt: { $lt: cutoff },
    $or: [{ lastDownloadAt: null }, { lastDownloadAt: { $lt: new Date(Date.now() - 15 * 60000) } }] }, { $set: { state: 'expired' } });
  const jobs = await MediaJob.find({ kind: { $in: ['archive', 'preview', 'proof'] }, state: { $ne: 'running' }, 'outputIds.0': { $exists: true },
    $or: [{ state: { $in: ['expired', 'failed', 'queued'] } }, { 'outputIds.1': { $exists: true } }] }).limit(100).lean();
  for (const job of jobs) {
    for (const outputId of job.outputIds) {
      if (job.state === 'ready' && outputId === job.outputId) continue;
      if (job.kind === 'preview' && await MediaAsset.exists({ thumbnailId: outputId })) continue;
      if (job.kind === 'proof' && await ProofPage.exists({ imageId: new mongoose.Types.ObjectId(outputId) })) continue;
      const prefix = job.kind === 'proof' ? 'proofPages' : job.kind === 'preview' ? 'mediaDerivatives' : 'mediaArchives';
      const id = new mongoose.Types.ObjectId(outputId);
      await mongoose.connection.db.collection(`${prefix}.files`).deleteOne({ _id: id });
      await mongoose.connection.db.collection(`${prefix}.chunks`).deleteMany({ files_id: id });
      await MediaJob.updateOne({ _id: job._id }, { $pull: { outputIds: outputId } });
    }
  }
}

async function buildPreview(job, signal) {
  const asset = await MediaAsset.findById(job.assetId).lean();
  if (!asset) return;
  const output = bucket('mediaDerivatives').openUploadStreamWithId(new mongoose.Types.ObjectId(job.outputId), `${asset._id}.webp`, { contentType: 'image/webp', timeoutMS: 220000 });
  const hash = createHash('sha256');
  const tap = new Transform({ transform(chunk, encoding, cb) { hash.update(chunk); cb(null, chunk); } });
  try {
    await pipeline(await openAssetStream(asset), tap,
      sharp({ limitInputPixels: 60000000, sequentialRead: true }).rotate().resize(480, 480, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }), output, { signal });
    await MediaAsset.updateOne({ _id: asset._id }, { $set: { thumbnailId: job.outputId, sha256: hash.digest('hex'), previewError: '' } });
  } catch (error) {
    await output.abort().catch(() => {});
    // A format the installed decoder cannot read still has a usable original.
    if (/unsupported image|bad seek|heif|corrupt|pixel limit|invalid.*image/i.test(error.message)) {
      await MediaAsset.updateOne({ _id: asset._id }, { $set: { previewError: 'Preview unavailable for this format. Download the original.' } });
      return;
    }
    throw error;
  }
}

export async function createPhotoArchive(order, folder, destination, signal) {
  const entries = photoArchiveEntries(order.uploadedPhotos, folder, path.join(process.cwd(), 'uploads', 'photos'));
  const assetIds = entries.filter((e) => e.assetId).map((e) => e.assetId);
  const gridIds = entries.filter((e) => e.gridFsId).map((e) => new mongoose.Types.ObjectId(e.gridFsId));
  const [assets, files] = await Promise.all([
    MediaAsset.find({ _id: { $in: assetIds } }).lean(),
    mongoose.connection.db.collection('orderPhotos.files').find({ _id: { $in: gridIds } }, { projection: { _id: 1 } }).toArray(),
  ]);
  const byId = new Map(assets.map((a) => [a._id, a]));
  const existing = new Set(files.map((f) => String(f._id)));
  if (entries.some((e) => e.assetId ? !byId.has(e.assetId) : e.gridFsId ? !existing.has(e.gridFsId) : !fs.existsSync(e.diskPath))) throw mediaError(409, 'Some photos in this folder are unavailable');
  const archive = new ZipArchive({ store: true });
  const transfer = pipeline(archive, destination, { signal });
  for (const entry of entries) {
    // Lazy streams open only when the archiver consumes this entry.
    const stream = Readable.from((async function* () {
      const source = entry.assetId ? await openAssetStream(byId.get(entry.assetId))
        : entry.gridFsId ? bucket('orderPhotos').openDownloadStream(new mongoose.Types.ObjectId(entry.gridFsId)) : fs.createReadStream(entry.diskPath);
      try { for await (const chunk of source) { signal?.throwIfAborted(); yield chunk; } }
      finally { source.destroy(); }
    })());
    archive.append(stream, { name: entry.archiveName, store: true });
  }
  try { await Promise.all([transfer, archive.finalize()]); }
  finally { archive.abort(); }
}

async function buildArchive(job, signal) {
  const order = await Order.findById(job.orderId).lean();
  if (!order) throw mediaError(404, 'Order no longer exists');
  const output = bucket('mediaArchives').openUploadStreamWithId(new mongoose.Types.ObjectId(job.outputId), `${job._id}.zip`, { contentType: 'application/zip', timeoutMS: 220000 });
  try { await createPhotoArchive(order, job.folder, output, signal); }
  catch (error) { await output.abort().catch(() => {}); throw error; }
}

// A database lease keeps preview decoding/archive generation to one job globally.
// Work is awaited by a scheduled invocation or a persistent worker, never detached.
export async function runMediaJobs({ maxJobs = 100, budgetMs = 230000, proofFilter = null } = {}) {
  if (proofFilter) return runProofJobs({maxJobs,budgetMs,filter:proofFilter});
  const owner = randomUUID(); const started = Date.now(); let count = 0;
  try {
    const lock = await MediaJob.findOneAndUpdate({ _id: 'worker-lock', $or: [{ leaseUntil: { $lt: new Date() } }, { leaseUntil: null }] },
      { $set: { kind: 'lock', owner, leaseUntil: new Date(Date.now() + 60000) } }, { upsert: true, returnDocument: 'after' });
    if (!lock) return { processed: 0 };
  } catch (e) { if (e.code === 11000) return { processed: 0 }; throw e; }
  let heartbeat;
  try {
    await MediaJob.updateMany({ kind:{$in:['preview','archive']}, state: 'running', leaseUntil: { $lt: new Date() }, attempts: { $gte: 3 } },
      { $set: { state: 'failed', error: 'Worker stopped repeatedly. Please contact staff.' } });
    if (!proofFilter) { await cleanDerivedMedia(); await cleanExpiredDraftUploads(); }
    while (count < maxJobs && Date.now() - started < budgetMs - 1000) {
      const outputId = new mongoose.Types.ObjectId().toString();
      const job = await MediaJob.findOneAndUpdate({ kind: { $in: ['preview', 'archive'] }, attempts: { $lt: 3 }, $or: [
        { state: 'queued', runAfter: { $lte: new Date() } }, { state: 'running', leaseUntil: { $lt: new Date() } },
      ] }, { $set: { state: 'running', owner, leaseUntil: new Date(Date.now() + 60000), outputId }, $push: { outputIds: outputId }, $inc: { attempts: 1 } },
      { sort: { priority: -1, createdAt: 1 }, returnDocument: 'after' }).lean();
      if (!job) break;
      const jobStarted = performance.now();
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, budgetMs - (Date.now() - started)))]);
      heartbeat = setInterval(async () => {
        try {
          const result = await MediaJob.updateOne({ _id: 'worker-lock', owner }, { $set: { leaseUntil: new Date(Date.now() + 60000) } });
          if (!result.modifiedCount) controller.abort();
          await MediaJob.updateOne({ _id: job._id, owner }, { $set: { leaseUntil: new Date(Date.now() + 60000) } });
        } catch { controller.abort(); }
      }, 15000);
      try {
        if (job.kind === 'preview') await buildPreview(job, signal); else await buildArchive(job, signal);
        await MediaJob.updateOne({ _id: job._id, owner }, { $set: { state: 'ready', completedAt: new Date() } });
      } catch (error) {
        await MediaJob.updateOne({ _id: job._id, owner }, { $set: {
          state: job.attempts >= 3 || error.status === 409 ? 'failed' : 'queued',
          error: error.message, runAfter: new Date(Date.now() + 30000 * job.attempts),
        } });
      } finally {
        clearInterval(heartbeat); heartbeat = null;
        console.info(JSON.stringify({ event: 'media_job', kind: job.kind, id: job._id, attempt: job.attempts,
          durationMs: Math.round(performance.now() - jobStarted), rssBytes: process.memoryUsage().rss }));
      }
      count++;
    }
  } finally {
    clearInterval(heartbeat);
    await MediaJob.updateOne({ _id: 'worker-lock', owner }, { $set: { leaseUntil: new Date(0) } });
  }
  if (process.env.PROOF_WORKER_MODE !== 'dedicated' && count < maxJobs) {
    const result=await runProofJobs({maxJobs:maxJobs-count,budgetMs:Math.max(1001,budgetMs-(Date.now()-started))});count+=result.processed;
  }
  return { processed: count };
}

export async function cleanExpiredUploads({ limit = 10 } = {}) {
  // Allow in-flight requests and recovery a full day beyond session expiry.
  const sessions = await UploadSession.find({ expiresAt: { $lt: new Date(Date.now() - 86400000) }, state: { $in: ['open', 'submitted', 'expired'] } }).limit(limit).lean();
  let reclaimed = 0;
  for (const session of sessions) {
    await UploadSession.updateOne({ _id: session._id, state: { $ne: 'finalizing' } }, { $set: { state: 'expired' } });
    const order = await Order.findOne({ mediaSessionId: session._id }).lean();
    const retained = new Set((order?.uploadedPhotos || []).map((p) => p.assetId));
    for (const entry of session.entries) {
      if (retained.has(entry._id)) continue;
      if (entry.provider === 'blob') await del(blobPath(entry._id));
      const id = new mongoose.Types.ObjectId(entry._id);
      await mongoose.connection.db.collection('orderPhotos.files').deleteOne({ _id: id });
      await mongoose.connection.db.collection('orderPhotos.chunks').deleteMany({ files_id: id });
      const asset = await MediaAsset.findById(entry._id).lean();
      if (asset?.thumbnailId) await bucket('mediaDerivatives').delete(new mongoose.Types.ObjectId(asset.thumbnailId)).catch(() => {});
      await MediaAsset.deleteOne({ _id: entry._id });
      await MediaJob.deleteOne({ _id: `preview:${entry._id}`, state: { $ne: 'running' } });
      reclaimed++;
    }
    // Leave submitted-session receipts and historical orders intact.
    await UploadSession.updateOne({ _id: session._id }, { $set: { expiresAt: new Date('9999-01-01'), entries: session.entries.filter((e) => retained.has(e._id)) } });
  }
  return { reclaimed };
}
