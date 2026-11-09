import mongoose from 'mongoose';
import multer from 'multer';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ProofAttachment } from '../models/ProofAttachment.model.js';
import { revisionCommentAudio } from './revisionAudioMetadata.js';

export const MAX_REVISION_AUDIO_BYTES = 3 * 1024 * 1024;
const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'revisionAudio' });
const invalid = (message) => Object.assign(new Error(message), { status: 400 });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_REVISION_AUDIO_BYTES, files: 1, fields: 2, fieldSize: 64 * 1024 } }).single('audio');

export function parseRevisionUpload(req, res, next) {
  upload(req, res, (error) => {
    if (error) return res.status(400).json({ message: error.code === 'LIMIT_FILE_SIZE' ? 'Audio must be 3 MB or smaller' : 'Unable to upload audio' });
    try {
      req.body ||= {};
      if (typeof req.body.items === 'string') req.body.items = JSON.parse(req.body.items);
      if (req.body.items !== undefined && !Array.isArray(req.body.items)) throw invalid('Invalid correction items');
      if (req.file) req.file.audioType = validateRevisionAudio(req.file);
      next();
    } catch (error) { res.status(400).json({ message: error instanceof SyntaxError ? 'Invalid correction items' : error.message }); }
  });
}

export function validateRevisionAudio(file) {
  const b = file.buffer;
  if (!b?.length || b.length > MAX_REVISION_AUDIO_BYTES) throw invalid('Audio must be between 1 byte and 3 MB');
  const ext = file.originalname.toLowerCase().split('.').pop();
  const mime = file.mimetype.split(';')[0].toLowerCase();
  const rules = [
    [['mp3'], ['audio/mpeg', 'audio/mp3'], 'audio/mpeg', b.subarray(0, 3).toString() === 'ID3' || (b[0] === 255 && (b[1] & 224) === 224)],
    [['m4a', 'mp4'], ['audio/mp4', 'audio/x-m4a'], 'audio/mp4', b.subarray(4, 8).toString() === 'ftyp'],
    [['wav'], ['audio/wav', 'audio/x-wav', 'audio/wave'], 'audio/wav', b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WAVE'],
    [['ogg', 'oga', 'opus'], ['audio/ogg', 'audio/opus'], 'audio/ogg', b.subarray(0, 4).toString() === 'OggS'],
    [['webm'], ['audio/webm'], 'audio/webm', b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))],
    [['aac'], ['audio/aac', 'audio/x-aac'], 'audio/aac', b[0] === 255 && (b[1] & 246) === 240],
  ];
  const match = rules.find(([extensions, types, , signature]) => extensions.includes(ext) && (types.includes(mime) || !mime || mime === 'application/octet-stream') && signature);
  if (!match) throw invalid('Choose an MP3, M4A, WAV, OGG, WebM or AAC audio file');
  return match[2];
}

export async function saveRevisionAudio(file, orderId) {
  const contentType = validateRevisionAudio(file);
  const upload = bucket().openUploadStream('revision-audio', { contentType, metadata: { orderId: String(orderId) } });
  try { await pipeline(Readable.from(file.buffer), upload); }
  catch (error) { await bucket().delete(upload.id).catch(() => {}); throw error; }
  return { assetId: upload.id, contentType, size: file.buffer.length };
}

export const deleteRevisionAudio = audio => bucket().delete(audio.assetId);

export async function streamRevisionAudio(req, res, order, clientOnly = false) {
  const round = order?.revisionRequests.id(req.params.requestId);
  const item = round?.items.id(req.params.itemId);
  if (!item || (clientOnly && round.source !== 'client')) return res.status(404).json({ message: 'Audio not found' });
  let storage = bucket(), contentType = item.audio?.contentType, file;
  if (item.audio?.assetId) {
    file = await storage.find({ _id: item.audio.assetId, 'metadata.orderId': String(order._id) }).next();
  } else {
    const attachment = revisionCommentAudio(order.proofAnnotations, round, item);
    if (!attachment || !mongoose.isValidObjectId(attachment.id)) return res.status(404).json({ message: 'Audio not found' });
    const asset = await ProofAttachment.findOne({ _id: attachment.id, orderId: order._id,
      version: round.draftVersionNumber, source: round.source, annotationId: item.annotationId, state: 'attached' }).lean();
    contentType = asset?.storedContentType || asset?.contentType;
    if (!contentType?.startsWith('audio/')) return res.status(404).json({ message: 'Audio not found' });
    storage = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'proofAttachments' });
    file = await storage.find({ _id: asset.imageId }).next();
  }
  if (!file) return res.status(404).json({ message: 'Audio not found' });
  res.set({ 'Content-Type': contentType, 'Content-Length': String(file.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  await pipeline(storage.openDownloadStream(file._id), res);
}
