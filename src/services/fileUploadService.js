import { assertFullyPaid } from './paymentPolicy.js';
import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import { Order } from '../models/Order.model.js';
import { permits } from './authorizationService.js';
import { assertNoActiveImageContent } from './uploadService.js';
import { UPLOAD_BATCH_PARTS, MAX_UPLOAD_BATCH_BYTES, uploadHash, writeUploadBatch } from './uploadBatchService.js';

export const FILE_CHUNK_BYTES = 1024 * 1024;
export const FileUpload = mongoose.model('FileUpload', new mongoose.Schema({
  staffId: { type: mongoose.Schema.Types.ObjectId, required: true }, orderId: mongoose.Schema.Types.ObjectId,
  purpose: String, clientId: String, name: String, contentType: String, size: Number, fingerprint: String, chunkBytes: Number,
  assetId: mongoose.Schema.Types.ObjectId, state: { type: String, default: 'open' }, expiresAt: Date,
}, { timestamps: true }).index({ staffId: 1, clientId: 1 }, { unique: true }).index({ expiresAt: 1 }));
const fail = (status, message) => Object.assign(new Error(message), { status });
const db = () => mongoose.connection.db;
const bucketName = session => session.purpose === 'cover' ? 'coverImages' : 'draftFiles';
export const fileChunkBytes = session => session.chunkBytes || FILE_CHUNK_BYTES;
const collection = (session, kind) => db().collection(`${bucketName(session)}.${kind}`);
let indexDb;
const indexes = new Map();
async function ensureIndex(session) {
  if (indexDb !== db()) { indexDb = db(); indexes.clear(); }
  const name = bucketName(session);
  if (!indexes.has(name)) indexes.set(name, collection(session, 'chunks').createIndex({ files_id: 1, n: 1 }, { unique: true }).catch(error => { indexes.delete(name); throw error; }));
  await indexes.get(name);
}
async function authorize(user, session) {
  if (session.purpose === 'cover') {
    if (user.role !== 'admin') throw fail(403, 'Only administrators can upload covers');
  } else if (session.purpose === 'print') {
    if (!mongoose.isValidObjectId(session.orderId)) throw fail(400, 'Choose a valid order');
    const order = await Order.findById(session.orderId);
    if (!permits(user, 'draft.upload', order)) throw fail(403, 'Order is not assigned to you');
    if (!['client_approved', 'print_document_prep'].includes(order.status)) throw fail(409, 'The magazine must be approved before uploading its print file');
    await order.populate('formId', 'price currency');
    assertFullyPaid(order);
  } else throw fail(400, 'Invalid upload purpose');
}
export async function reserveFileUpload(user, input) {
  await authorize(user, input);
  const cover = input.purpose === 'cover', max = (cover ? 25 : 500) * 1024 * 1024;
  if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > max) throw fail(413, `Choose a file up to ${cover ? 25 : 500} MB`);
  if (!/^[a-f0-9-]{36}$/i.test(input.clientId || '') || !/^[a-f0-9]{64}$/.test(input.fingerprint || '')) throw fail(400, 'Invalid upload identity');
  if (cover ? !/^image\/(jpeg|png|webp|heic|heif|avif|gif)$/.test(input.contentType) : input.contentType !== 'application/pdf' || !/\.pdf$/i.test(input.name)) throw fail(400, cover ? 'Choose a supported image' : 'Choose a PDF file');
  const filter = { staffId: user._id, clientId: input.clientId };
  if (!await FileUpload.exists(filter) && await FileUpload.countDocuments({ staffId: user._id, state: 'open', expiresAt: { $gt: new Date() } }) >= 10) throw fail(429, 'Finish your pending uploads first');
  let session;
  try {
    session = await FileUpload.findOneAndUpdate(filter, { $setOnInsert: { ...filter,
      purpose: input.purpose, orderId: input.orderId, name: String(input.name || 'cover').slice(0, 255),
      size: input.size, contentType: input.contentType, fingerprint: input.fingerprint, chunkBytes: input.chunkBytes === FILE_CHUNK_BYTES / 2 ? FILE_CHUNK_BYTES / 2 : FILE_CHUNK_BYTES,
      assetId: new mongoose.Types.ObjectId(), expiresAt: new Date(Date.now() + 86400000),
    } }, { upsert: true, returnDocument: 'after' });
  } catch (error) {
    if (error.code !== 11000) throw error;
    session = await FileUpload.findOne(filter);
  }
  if (session.size !== input.size || session.fingerprint !== input.fingerprint || session.purpose !== input.purpose || session.contentType !== input.contentType || String(session.orderId || '') !== String(input.orderId || '')) throw fail(409, 'Upload details changed. Select the original file.');
  if (session.expiresAt <= new Date() || session.state === 'expired') throw fail(410, 'Upload expired. Select the file again.');
  await ensureIndex(session);
  return describeFileUpload(session);
}
export async function ownedFileUpload(user, id, purpose) {
  if (!mongoose.isValidObjectId(id)) throw fail(404, 'Upload not found');
  const session = await FileUpload.findOne({ _id: id, staffId: user._id });
  if (!session || purpose && session.purpose !== purpose) throw fail(404, 'Upload not found');
  if (session.expiresAt <= new Date() || session.state === 'expired') throw fail(410, 'Upload expired. Select the file again.');
  await authorize(user, session);
  return session;
}
export async function describeFileUpload(session) {
  const chunks = await collection(session, 'chunks').find({ files_id: session.assetId }, { projection: { n: 1, sha256: 1, _id: 0 } }).toArray();
  return { id: String(session._id), state: session.state, chunkBytes: fileChunkBytes(session), batchParts: UPLOAD_BATCH_PARTS, compression: 'gzip', chunks,
    ...(session.state === 'complete' && session.purpose === 'cover' ? { coverUrl: `/api/public/covers/${session.assetId}` } : {}) };
}
export async function uploadWholeFile(user, input, bytes, expectedHash) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== input.size || bytes.length > MAX_UPLOAD_BATCH_BYTES) throw fail(400, 'Invalid upload size');
  if (uploadHash(bytes) !== expectedHash) throw fail(409, 'Upload verification failed. Retry the file.');
  const status = await reserveFileUpload(user, input);
  const session = await ownedFileUpload(user, status.id);
  const saved = new Map(status.chunks.map(part => [part.n, part.sha256]));
  await writeUploadBatch({ bytes, start: 0, size: session.size, chunkBytes: fileChunkBytes(session), expectedHash,
    write: async (n, part, hash) => {
      if (saved.has(n)) {
        if (saved.get(n) !== hash) throw fail(409, 'This file differs from the original upload');
      } else await putFileChunk(session, n, part, hash);
    },
  });
  return completeFileUpload(session);
}
export async function putFileChunk(session, n, bytes, expectedHash) {
  if (session.state !== 'open') throw fail(409, 'Upload is already complete');
  const chunkBytes = fileChunkBytes(session), length = Math.min(chunkBytes, session.size - n * chunkBytes);
  if (!Number.isInteger(n) || n < 0 || n >= Math.ceil(session.size / chunkBytes) || !Buffer.isBuffer(bytes) || bytes.length !== length) throw fail(400, 'Invalid upload part');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expectedHash) throw fail(409, 'Upload verification failed. Retry this part.');
  if (n === 0) {
    if (session.purpose === 'cover') assertNoActiveImageContent(bytes);
    else if (bytes.subarray(0, 5).toString() !== '%PDF-') throw fail(400, 'Choose a valid PDF file');
  }
  await ensureIndex(session);
  const filter = { files_id: session.assetId, n };
  let stored;
  try { stored = await collection(session, 'chunks').findOneAndUpdate(filter, { $setOnInsert: { ...filter, data: bytes, length, sha256 } }, { upsert: true, returnDocument: 'after', projection: { sha256: 1 } }); }
  catch (error) { if (error.code !== 11000) throw error; stored = await collection(session, 'chunks').findOne(filter, { projection: { sha256: 1 } }); }
  if (stored.sha256 !== sha256) throw fail(409, 'This part differs from the original upload');
}
export async function completeFileUpload(session) {
  const chunkBytes = fileChunkBytes(session);
  const chunks = await collection(session, 'chunks').find({ files_id: session.assetId }, { projection: { n: 1, length: 1 } }).sort({ n: 1 }).toArray();
  if (chunks.length !== Math.ceil(session.size / chunkBytes) || chunks.some((part, n) => part.n !== n || part.length !== Math.min(chunkBytes, session.size - n * chunkBytes))) throw fail(409, 'Upload is incomplete. Resume the missing parts.');
  await collection(session, 'files').updateOne({ _id: session.assetId }, { $setOnInsert: {
    filename: session.name, length: session.size, chunkSize: chunkBytes, uploadDate: new Date(), contentType: session.contentType,
    metadata: { contentType: session.contentType, uploadedBy: session.staffId, orderId: session.orderId ? String(session.orderId) : undefined, purpose: session.purpose },
  } }, { upsert: true });
  await FileUpload.updateOne({ _id: session._id, state: 'open' }, { $set: { state: 'complete' } });
  return { success: true, id: String(session._id), ...(session.purpose === 'cover' ? { coverUrl: `/api/public/covers/${session.assetId}` } : {}) };
}
export async function cleanExpiredFileUploads() {
  const sessions = await FileUpload.find({ state: { $in: ['open', 'expired'] }, expiresAt: { $lt: new Date(Date.now() - 5 * 60000) } }).limit(20);
  for (const session of sessions) {
    const claimed = await FileUpload.updateOne({ _id: session._id, state: { $in: ['open', 'expired'] } }, { $set: { state: 'expired' } });
    if (!claimed.matchedCount) continue;
    await collection(session, 'chunks').deleteMany({ files_id: session.assetId });
    await collection(session, 'files').deleteOne({ _id: session.assetId });
    await FileUpload.deleteOne({ _id: session._id, state: 'expired' });
  }
}
