import mongoose from 'mongoose';
import { createHash, timingSafeEqual } from 'node:crypto';
import { head, BlobNotFoundError } from '@vercel/blob';
import { UploadSession, MediaAsset, MediaJob } from '../models/Media.model.js';
import { MagazineForm } from '../models/MagazineForm.model.js';
import { Order } from '../models/Order.model.js';
import { AuditLog } from '../models/AuditLog.model.js';
import { validateFormAnswers } from './formResponseService.js';
import { mediaError } from './mediaErrors.js';

export const CHUNK_BYTES = 1024 * 1024;
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const mediaLimits = () => ({ chunkBytes: CHUNK_BYTES,
  maxFileBytes: Number(process.env.MEDIA_MAX_FILE_BYTES) || 25 * 1024 * 1024,
  maxFiles: Number(process.env.MEDIA_MAX_FILES) || 100,
  maxTotalBytes: Number(process.env.MEDIA_MAX_TOTAL_BYTES) || 1024 * 1024 * 1024 });
export const blobPath = (id) => `tinzel/originals/${id}`;
export const photoDescriptor = (asset) => ({ assetId: asset._id,
  url: `/api/public/media/assets/${asset._id}`, thumbnailUrl: `/api/public/media/assets/${asset._id}/thumbnail`,
  originalName: asset.name, size: asset.size, fieldId: asset.fieldId,
  folderName: asset.folderName, uploadedAt: asset.createdAt });
const uuid = /^[a-f0-9-]{36}$/i;
const db = () => mongoose.connection.db;
let indexDb, indexPromise;
export async function ensureMediaIndexes() {
  if (indexDb !== db() || !indexPromise) {
    indexDb = db();
    indexPromise = Promise.all([
      db().collection('orderPhotos.chunks').createIndex({ files_id: 1, n: 1 }, { unique: true }),
      db().collection('orderPhotos.files').createIndex({ filename: 1, uploadDate: 1 }),
    ]).catch((e) => { indexPromise = null; throw e; });
  }
  return indexPromise;
}

export async function getSession(id, token) {
  const session = uuid.test(String(id)) ? await UploadSession.findById(id).lean() : null;
  const supplied = digest(String(token || ''));
  if (!session || !timingSafeEqual(Buffer.from(session.tokenHash), Buffer.from(supplied))) {
    throw mediaError(404, 'Upload session not found. Please reopen the form.');
  }
  if (session.expiresAt < new Date() || session.state === 'expired') throw mediaError(410, 'This upload session has expired. Please start again.');
  return session;
}

export async function createSession(slug, id, token) {
  if (!uuid.test(String(id)) || !/^[a-f0-9]{64}$/i.test(String(token))) throw mediaError(400, 'Invalid upload session');
  const form = await MagazineForm.findOne({ slug, isActive: true, isArchived: false }).lean();
  if (!form) throw mediaError(404, 'Magazine form not found or inactive');
  await UploadSession.updateOne({ _id: id }, { $setOnInsert: {
    tokenHash: digest(token), formId: form._id, slug, entries: [], state: 'open', revision: 0,
    expiresAt: new Date(Date.now() + 7 * 86400000),
    orderId: new mongoose.Types.ObjectId(), auditId: new mongoose.Types.ObjectId(),
  } }, { upsert: true });
  const session = await getSession(id, token);
  if (session.slug !== slug) throw mediaError(409, 'Upload session belongs to another form');
  return session;
}

export function validateReservation(form, entries, input, limits = mediaLimits()) {
  if (!uuid.test(String(input.clientId)) || !Number.isSafeInteger(input.size) || input.size <= 0) throw mediaError(400, 'Invalid photo details');
  if (input.size > limits.maxFileBytes) throw mediaError(413, `Each photo must be at most ${Math.floor(limits.maxFileBytes / 1024 / 1024)} MB`);
  if (!/^image\/(jpeg|png|webp|heic|heif|avif|gif)$/.test(input.contentType)) throw mediaError(400, 'Choose a JPG, PNG, WebP, HEIC, HEIF, AVIF or GIF image');
  const field = (form.fields || []).find((f) => f.fieldId === input.fieldId);
  if (input.fieldId && (!field || !['photo_upload', 'photo_group'].includes(field.type))) throw mediaError(400, 'Photo question not found');
  const active = entries.filter((e) => !e.removedAt);
  const fieldMax = field?.type === 'photo_upload' ? 1 : Number(field?.validationRules?.maxPhotos || limits.maxFiles);
  if (active.filter((e) => e.fieldId === (input.fieldId || '')).length >= fieldMax) throw mediaError(400, `This question allows at most ${fieldMax} photos`);
  if (active.length >= limits.maxFiles || active.reduce((sum, e) => sum + e.size, 0) + input.size > limits.maxTotalBytes) throw mediaError(413, 'This submission has reached its photo capacity');
  return { _id: new mongoose.Types.ObjectId().toString(), clientId: input.clientId,
    name: String(input.name || 'photo').slice(0, 255), size: input.size, contentType: input.contentType,
    fieldId: input.fieldId || '', folderName: field?.label || 'General Photos',
    provider: process.env.MEDIA_STORAGE === 'blob' && process.env.BLOB_READ_WRITE_TOKEN ? 'blob' : 'gridfs' };
}

export async function reservePhoto(id, token, input) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const session = await getSession(id, token);
    if (session.cancelledIds?.includes(input.clientId)) throw mediaError(409, 'This photo was removed. Select it again to start a new upload.');
    const existing = session.entries.find((e) => e.clientId === input.clientId && !e.removedAt);
    if (existing) {
      if (existing.size !== input.size || existing.name !== input.name || existing.fieldId !== (input.fieldId || '')) throw mediaError(409, 'Photo details changed. Select it again.');
      return existing;
    }
    if (session.state !== 'open') throw mediaError(409, 'This submission is already being completed');
    const form = await MagazineForm.findOne({ _id: session.formId, isActive: true, isArchived: false }).lean();
    if (!form) throw mediaError(404, 'Magazine form is no longer available');
    const entry = validateReservation(form, session.entries, input);
    const result = await UploadSession.updateOne({ _id: id, state: 'open', revision: session.revision }, {
      $push: { entries: entry }, $inc: { revision: 1 },
    });
    if (result.modifiedCount) return entry;
  }
  throw mediaError(503, 'Uploads are busy. Please retry this photo.');
}

export async function getEntry(id, token, assetId, { writable = true } = {}) {
  const session = await getSession(id, token);
  const entry = session.entries.find((e) => e._id === assetId && !e.removedAt);
  if (!entry) throw mediaError(404, 'Photo not found in this session');
  if (writable && session.state !== 'open') throw mediaError(409, 'This submission is already being completed');
  return { session, entry };
}

export async function chunkStatus(entry) {
  return db().collection('orderPhotos.chunks').find({ files_id: new mongoose.Types.ObjectId(entry._id) },
    { projection: { n: 1, length: 1, sha256: 1 }, timeoutMS: 15000 }).sort({ n: 1 }).toArray();
}

export async function writeChunk(entry, n, buffer) {
  if (entry.provider !== 'gridfs' || !Number.isInteger(n) || n < 0 || n >= Math.ceil(entry.size / CHUNK_BYTES)) throw mediaError(400, 'Invalid upload part');
  const expected = Math.min(CHUNK_BYTES, entry.size - n * CHUNK_BYTES);
  if (!Buffer.isBuffer(buffer) || buffer.length !== expected) throw mediaError(400, 'Incomplete upload part. Retry this photo.');
  await ensureMediaIndexes();
  const filter = { files_id: new mongoose.Types.ObjectId(entry._id), n };
  const sha256 = digest(buffer);
  try {
    await db().collection('orderPhotos.chunks').updateOne(filter,
      { $setOnInsert: { ...filter, data: buffer, length: buffer.length, sha256 } }, { upsert: true, timeoutMS: 20000 });
  } catch (e) { if (e.code !== 11000) throw e; }
  const stored = await db().collection('orderPhotos.chunks').findOne(filter, { projection: { sha256: 1 }, timeoutMS: 10000 });
  if (stored?.sha256 !== sha256) throw mediaError(409, 'This photo differs from its uploaded parts. Remove it and select the original again.');
}

export async function completePhoto(sessionId, entry) {
  const existing = await MediaAsset.findById(entry._id).lean();
  if (!existing && entry.provider === 'blob') {
    let info;
    try { info = await head(blobPath(entry._id), { abortSignal: AbortSignal.timeout(20000) }); }
    catch (error) { if (error instanceof BlobNotFoundError) throw mediaError(409, 'Photo transfer is incomplete'); throw error; }
    if (info.size !== entry.size || info.contentType !== entry.contentType) throw mediaError(409, 'Photo transfer is incomplete');
  } else if (!existing) {
    const chunks = await chunkStatus(entry);
    if (chunks.length !== Math.ceil(entry.size / CHUNK_BYTES) || chunks.some((c, n) => c.n !== n || c.length !== Math.min(CHUNK_BYTES, entry.size - n * CHUNK_BYTES))) throw mediaError(409, 'Photo transfer is incomplete');
    await db().collection('orderPhotos.files').updateOne({ _id: new mongoose.Types.ObjectId(entry._id) }, { $setOnInsert: {
      length: entry.size, chunkSize: CHUNK_BYTES, uploadDate: new Date(), filename: entry.name,
      contentType: entry.contentType, metadata: { sessionId, contentType: entry.contentType },
    } }, { upsert: true, timeoutMS: 15000 });
  }
  const asset = existing || await MediaAsset.findOneAndUpdate({ _id: entry._id }, { $setOnInsert: {
    ...entry, sessionId, blobPath: entry.provider === 'blob' ? blobPath(entry._id) : undefined,
  } }, { upsert: true, returnDocument: 'after' }).lean();
  await MediaJob.updateOne({ _id: `preview:${entry._id}` }, { $setOnInsert: { kind: 'preview', assetId: entry._id } }, { upsert: true });
  return asset;
}

export async function removePhoto(id, token, assetId) {
  const { session } = await getEntry(id, token, assetId);
  const changed = await UploadSession.updateOne({ _id: id, state: 'open', revision: session.revision }, {
    $set: { 'entries.$[entry].removedAt': new Date() }, $inc: { revision: 1 },
  }, { arrayFilters: [{ 'entry._id': assetId }] });
  if (!changed.modifiedCount) throw mediaError(409, 'Photo list changed. Please retry.');
  // Reclaim only after the session recovery window; an in-flight part can still arrive.
}

export async function cancelSelection(id, token, clientId) {
  const session = await getSession(id, token);
  if (!uuid.test(clientId) || session.state !== 'open') throw mediaError(409, 'This photo cannot be removed now');
  const result = await UploadSession.updateOne({ _id: id, state: 'open' }, {
    $addToSet: { cancelledIds: clientId }, $set: { 'entries.$[entry].removedAt': new Date() }, $inc: { revision: 1 },
  }, { arrayFilters: [{ 'entry.clientId': clientId }] });
  if (!result.matchedCount) throw mediaError(409, 'This submission is being completed');
}

export async function finalizeSession(id, token, body) {
  let session = await getSession(id, token);
  if (session.result) return session.result;
  if (!session.finalization) {
    const form = await MagazineForm.findOne({ _id: session.formId, isActive: true, isArchived: false }).lean();
    if (!form) throw mediaError(404, 'Magazine form is no longer available');
    if (!String(body.clientName || '').trim() || !String(body.clientWhatsApp || '').trim()) throw mediaError(400, 'Name and WhatsApp number are required');
    const active = session.entries.filter((e) => !e.removedAt);
    const ids = body.assetIds;
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.length !== active.length || active.some((e) => !ids.includes(e._id))) throw mediaError(409, 'Photo selection has changed. Please review your photos.');
    const assets = await MediaAsset.find({ _id: { $in: ids }, sessionId: id }).lean();
    if (assets.length !== ids.length) throw mediaError(409, 'Wait until every photo has finished uploading');
    const byId = new Map(assets.map((a) => [a._id, a]));
    const photos = active.map((e) => photoDescriptor(byId.get(e._id)));
    const errors = validateFormAnswers(form.fields, body.answers || {}, photos);
    if (errors.length) throw mediaError(400, errors[0]);
    const finalization = {
      order: { _id: session.orderId, mediaSessionId: id, submissionId: `SUB-${new Date().getFullYear()}-${session.orderId.toString().toUpperCase()}`,
        formId: form._id, formTitle: form.title, clientName: String(body.clientName).trim(),
        clientWhatsApp: String(body.clientWhatsApp).trim(), clientEmail: String(body.clientEmail || '').trim(),
        submittedData: body.answers || {}, submittedFields: form.fields.map(({ fieldId, label, sectionId, order }) => ({ fieldId, label, sectionId, order })),
        uploadedPhotos: photos, status: 'awaiting_payment' },
      price: form.price, currency: form.currency, lipaNambaInstructions: form.lipaNambaInstructions,
    };
    await UploadSession.updateOne({ _id: id, state: 'open', revision: session.revision }, { $set: { state: 'finalizing', finalization }, $inc: { revision: 1 } });
    session = await getSession(id, token);
    if (!session.finalization) throw mediaError(409, 'Photo selection changed. Please submit again.');
  }
  const snap = session.finalization;
  const order = await Order.findOneAndUpdate({ _id: session.orderId }, { $setOnInsert: snap.order }, { upsert: true, returnDocument: 'after', runValidators: true });
  await AuditLog.updateOne({ _id: session.auditId }, { $setOnInsert: { actor: { type: 'client', name: order.clientName },
    action: 'ORDER_SUBMITTED', orderId: order._id, details: { submissionId: order.submissionId, photosCount: order.uploadedPhotos.length, formSlug: session.slug } } }, { upsert: true });
  const result = { success: true, order: { submissionId: order.submissionId, formTitle: order.formTitle,
    clientName: order.clientName, clientWhatsApp: order.clientWhatsApp, status: order.status,
    photosCount: order.uploadedPhotos.length, price: snap.price, currency: snap.currency }, lipaNambaInstructions: snap.lipaNambaInstructions };
  await UploadSession.updateOne({ _id: id }, { $set: { state: 'submitted', result } });
  return result;
}
