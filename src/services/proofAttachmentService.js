import mongoose from 'mongoose';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ProofAttachment } from '../models/ProofAttachment.model.js';
import { Order } from '../models/Order.model.js';
import { MAX_REVISION_AUDIO_BYTES, validateRevisionAudio } from './revisionAudioService.js';

export const ATTACHMENT_CHUNK_BYTES = 1024 * 1024;
const fail = (status, message) => Object.assign(new Error(message), { status });
const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'proofAttachments' });
const chunks = () => mongoose.connection.db.collection('proofAttachmentUploads');
let indexDb, indexPromise;
async function ensureUploadIndex() {
  if (indexDb !== mongoose.connection.db || !indexPromise) {
    indexDb = mongoose.connection.db;
    indexPromise = chunks().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(error => { indexPromise = null; throw error; });
  }
  await indexPromise;
}

export const attachmentScope = req => ({ orderId: req.proofOrder._id, version: req.proofVersion,
  source: req.proofSource, authorId: String(req.user?._id || req.proofOrder._id) });
const audioTypes = new Set(['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/ogg', 'audio/opus', 'audio/webm', 'audio/aac', 'audio/x-aac']);
const isAudio = asset => audioTypes.has(asset.contentType);
export const attachmentDescriptor = a => ({ id: String(a._id), name: a.name, contentType: a.storedContentType || (isAudio(a) ? a.contentType : 'image/webp'), width: a.width, height: a.height });
const editable = req => { if (!req.proofCanComment) throw fail(403, 'This version is not open for your review'); };
export async function ownedAttachment(req, id) {
  if (!mongoose.isValidObjectId(id)) throw fail(404, 'Attachment not found');
  const asset = await ProofAttachment.findOne({ _id: id, ...attachmentScope(req) });
  if (!asset || asset.state === 'deleting' || asset.expiresAt <= new Date()) throw fail(404, 'Attachment upload expired or unavailable');
  return asset;
}
export async function reserveAttachment(req) {
  editable(req);
  const { name, size, contentType, clientId } = req.body;
  const audio = audioTypes.has(contentType);
  if (!/^[a-f\d-]{36}$/i.test(String(clientId)) || !Number.isSafeInteger(size) || size < 1 || size > (audio ? MAX_REVISION_AUDIO_BYTES : 10 * ATTACHMENT_CHUNK_BYTES) || (!audio && !['image/jpeg', 'image/png', 'image/webp'].includes(contentType)))
    throw fail(400, 'Choose an image up to 10 MiB or audio up to 3 MB');
  const scope = attachmentScope(req);
  // Bound abandoned reservations as well as the five images permitted on each comment.
  if (!await ProofAttachment.exists({ ...scope, clientId }) && await ProofAttachment.countDocuments({ ...scope, state: { $in: ['uploading', 'processing', 'ready'] }, expiresAt: { $gt: new Date() } }) >= 25)
    throw fail(429, 'Finish or remove your pending uploads first');
  let asset;
  try {
    asset = await ProofAttachment.findOneAndUpdate({ ...scope, clientId }, { $setOnInsert: {
      name: String(name || 'image').slice(0, 200), size, contentType, expiresAt: new Date(Date.now() + 86400000),
      imageId: new mongoose.Types.ObjectId(), ...(!audio ? { thumbnailId: new mongoose.Types.ObjectId() } : {}),
    } }, { upsert: true, returnDocument: 'after' });
  } catch (error) {
    if (error.code !== 11000) throw error;
    asset = await ProofAttachment.findOne({ ...scope, clientId });
  }
  if (asset.size !== size || asset.contentType !== contentType || asset.state === 'deleting' || asset.expiresAt <= new Date()) throw fail(409, 'Choose this attachment again to start a new upload');
  const received = await chunks().find({ assetId: String(asset._id) }, { projection: { n: 1, sha256: 1 } }).toArray();
  return { id: String(asset._id), state: asset.state, chunkBytes: ATTACHMENT_CHUNK_BYTES, received, attachment: asset.state === 'ready' ? attachmentDescriptor(asset) : undefined };
}
export async function putAttachmentChunk(req) {
  editable(req);
  const asset = await ownedAttachment(req, req.params.attachmentId), n = Number(req.params.n);
  if (asset.state !== 'uploading') throw fail(409, 'Attachment is already being prepared');
  if (!Number.isInteger(n) || n < 0 || n >= Math.ceil(asset.size / ATTACHMENT_CHUNK_BYTES) || !Buffer.isBuffer(req.body) || req.body.length !== Math.min(ATTACHMENT_CHUNK_BYTES, asset.size - n * ATTACHMENT_CHUNK_BYTES)) throw fail(400, 'Incomplete attachment part');
  await ensureUploadIndex();
  const sha256 = createHash('sha256').update(req.body).digest('hex'), id = `${asset._id}:${n}`;
  try { await chunks().updateOne({ _id: id }, { $setOnInsert: { assetId: String(asset._id), n, sha256, bytes: req.body, expiresAt: asset.expiresAt } }, { upsert: true }); }
  catch (error) { if (error.code !== 11000) throw error; }
  if ((await chunks().findOne({ _id: id }, { projection: { sha256: 1 } })).sha256 !== sha256) throw fail(409, 'Attachment part differs from the previous upload');
  return { n, sha256 };
}
async function removeBytes(asset) {
  for (const id of [asset.imageId, asset.thumbnailId].filter(Boolean)) {
    await mongoose.connection.db.collection('proofAttachments.files').deleteOne({ _id: id });
    await mongoose.connection.db.collection('proofAttachments.chunks').deleteMany({ files_id: id });
  }
}
export async function completeAttachment(req) {
  editable(req);
  let asset = await ownedAttachment(req, req.params.attachmentId);
  if (asset.state === 'ready') return attachmentDescriptor(asset);
  asset = await ProofAttachment.findOneAndUpdate({ _id: asset._id, $or: [{ state: 'uploading' }, { state: 'processing', processingUntil: { $lt: new Date() } }] },
    { $set: { state: 'processing', processingUntil: new Date(Date.now() + 120000) } }, { returnDocument: 'after' });
  if (!asset) throw fail(409, 'Attachment is being prepared. Retry shortly');
  const processingId = asset._id;
  try {
    const parts = await chunks().find({ assetId: String(asset._id) }).sort({ n: 1 }).toArray();
    if (parts.length !== Math.ceil(asset.size / ATTACHMENT_CHUNK_BYTES) || parts.some((p, i) => p.n !== i)) throw fail(400, 'Wait until every attachment part has uploaded');
    const bytes = Buffer.concat(parts.map(p => Buffer.from(p.bytes.buffer)));
    if (bytes.length !== asset.size) throw fail(400, 'Incomplete attachment');
    if (isAudio(asset)) {
      const contentType = validateRevisionAudio({ buffer: bytes, originalname: asset.name, mimetype: asset.contentType });
      await removeBytes(asset);
      await pipeline(Readable.from(bytes), bucket().openUploadStreamWithId(asset.imageId, 'review-audio', { contentType }));
      asset = await ProofAttachment.findOneAndUpdate({ _id: asset._id, state: 'processing' }, { $set: { state: 'ready', storedContentType: contentType } }, { returnDocument: 'after' });
      if (!asset) throw fail(409, 'Audio is being prepared. Retry shortly');
      return attachmentDescriptor(asset);
    }
    const input = sharp(bytes, { limitInputPixels: 40000000, failOn: 'warning' });
    const metadata = await input.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format) || `image/${metadata.format}` !== asset.contentType || (metadata.pages || 1) !== 1) throw fail(400, 'Choose a still JPG, PNG or WebP image');
    const { data: image, info } = await input.rotate().webp({ quality: 92 }).toBuffer({ resolveWithObject: true });
    const thumbnail = await sharp(image).resize(320, 320, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    await removeBytes(asset);
    for (const [id, data] of [[asset.imageId, image], [asset.thumbnailId, thumbnail]])
      await pipeline(Readable.from(data), bucket().openUploadStreamWithId(id, 'review-image.webp', { contentType: 'image/webp' }));
    asset = await ProofAttachment.findOneAndUpdate({ _id: asset._id, state: 'processing' }, { $set: { state: 'ready', width: info.width, height: info.height } }, { returnDocument: 'after' });
    if (!asset) throw fail(409, 'Attachment is being prepared. Retry shortly');
    return attachmentDescriptor(asset);
  } catch (error) {
    await ProofAttachment.updateOne({ _id: processingId, state: 'processing' }, { $set: { state: 'uploading' } });
    if (!error.status && /pixel limit|unsupported image|corrupt|invalid|premature/i.test(error.message)) throw fail(400, 'Image could not be read or exceeds 40 megapixels');
    throw error;
  }
}
export async function claimAttachments(req, ids, annotationId) {
  if (!Array.isArray(ids) || ids.length > 6 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !mongoose.isValidObjectId(id))) throw fail(400, 'Choose up to five images and one audio message');
  const claimed = [];
  let audioCount = 0, imageCount = 0;
  try {
    for (const id of ids) {
      const asset = await ProofAttachment.findOneAndUpdate({ _id: id, ...attachmentScope(req), state: 'ready', expiresAt: { $gt: new Date() } },
        { $set: { state: 'attached', annotationId, expiresAt: new Date(Date.now() + 86400000) } }, { returnDocument: 'after' });
      if (!asset) throw fail(400, 'An attachment is unavailable. Retry its upload');
      if (isAudio(asset)) audioCount++; else imageCount++;
      if (audioCount > 1 || imageCount > 5) throw fail(400, 'Choose up to five images and one audio message');
      claimed.push(attachmentDescriptor(asset));
    }
    return claimed;
  } catch (error) { await releaseAttachmentClaims(annotationId); throw error; }
}
export async function releaseAttachmentClaims(annotationId) {
  if (!await Order.exists({ 'proofAnnotations._id': annotationId }))
    await ProofAttachment.updateMany({ annotationId, state: 'attached' }, { $set: { state: 'ready' }, $unset: { annotationId: 1 } });
}
export async function removeAttachment(req) {
  editable(req);
  const asset = await ownedAttachment(req, req.params.attachmentId);
  if (!['ready', 'uploading'].includes(asset.state)) throw fail(409, 'This attachment is in use');
  await ProofAttachment.updateOne({ _id: asset._id, state: { $in: ['ready', 'uploading'] } }, { $set: { expiresAt: new Date(0) } });
}
export async function readAttachment(req, visible) {
  const id = req.params.attachmentId;
  if (!mongoose.isValidObjectId(id)) throw fail(404, 'Attachment not found');
  const linked = visible.some(a => a.attachments?.some(v => v.id === id));
  const asset = await ProofAttachment.findOne({ _id: id, orderId: req.proofOrder._id, version: req.proofVersion });
  const owned = asset && req.proofCanComment && asset.source === req.proofSource && asset.authorId === attachmentScope(req).authorId && asset.state === 'ready' && asset.expiresAt > new Date();
  if (!asset || (!linked && !owned)) throw fail(404, 'Attachment not found');
  return { stream: bucket().openDownloadStream(req.query.thumbnail === '1' && !isAudio(asset) ? asset.thumbnailId : asset.imageId), contentType: attachmentDescriptor(asset).contentType };
}
export async function cleanProofAttachments() {
  await ProofAttachment.updateMany({ state: 'processing', processingUntil: { $lt: new Date() } }, { $set: { state: 'uploading' } });
  const expired = await ProofAttachment.find({ expiresAt: { $lt: new Date() } }).limit(100).lean();
  let removed = 0;
  for (const asset of expired) {
    // The annotation is authoritative, including old versions and submitted rounds.
    if (await Order.exists({ _id: asset.orderId, 'proofAnnotations.attachments.id': String(asset._id) })) {
      await chunks().deleteMany({ assetId: String(asset._id) });
      await ProofAttachment.updateOne({ _id: asset._id }, { $unset: { expiresAt: 1 } });
      continue;
    }
    const locked = await ProofAttachment.findOneAndUpdate({ _id: asset._id, expiresAt: { $lt: new Date() }, state: { $ne: 'processing' } }, { $set: { state: 'deleting' } });
    if (!locked) continue;
    await removeBytes(asset);
    await chunks().deleteMany({ assetId: String(asset._id) });
    await ProofAttachment.deleteOne({ _id: asset._id, state: 'deleting' });
    removed++;
  }
  return { removed };
}
