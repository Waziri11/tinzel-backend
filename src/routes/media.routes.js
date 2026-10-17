import express from 'express';
import { pipeline } from 'node:stream/promises';
import mongoose from 'mongoose';
import { handleUpload } from '@vercel/blob/client';
import { UploadSession, MediaAsset } from '../models/Media.model.js';
import { CHUNK_BYTES, createSession, getSession, getEntry, reservePhoto, writeChunk,
  chunkStatus, completePhoto, removePhoto, cancelSelection, finalizeSession, mediaLimits, blobPath, photoDescriptor } from '../services/mediaSessionService.js';
import { openAssetStream } from '../services/mediaReadService.js';
import { mediaError, respondMediaError } from '../services/mediaErrors.js';

const router = express.Router();
const token = (req) => req.headers['x-upload-token'];
const route = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) {
  if (res.headersSent) res.destroy(e); else respondMediaError(req, res, e);
} };

router.post('/sessions', route(async (req, res) => {
  const session = await createSession(String(req.body.slug || '').toLowerCase(), req.body.id, token(req));
  res.status(201).json({ success: true, id: session._id, limits: mediaLimits(), result: session.result });
}));
router.get('/sessions/:id', route(async (req, res) => {
  const session = await getSession(req.params.id, token(req));
  const completed = await MediaAsset.find({ sessionId: session._id }).lean();
  res.json({ success: true, entries: session.entries.filter((e) => !e.removedAt),
    completed: completed.map(photoDescriptor), state: session.state, result: session.result, limits: mediaLimits() });
}));
router.post('/sessions/:id/assets', route(async (req, res) => {
  const entry = await reservePhoto(req.params.id, token(req), req.body);
  res.status(201).json({ success: true, entry, path: blobPath(entry._id), chunkBytes: CHUNK_BYTES });
}));
router.get('/sessions/:id/assets/:assetId', route(async (req, res) => {
  const { entry } = await getEntry(req.params.id, token(req), req.params.assetId, { writable: false });
  const asset = await MediaAsset.findById(entry._id).lean();
  res.json({ success: true, photo: asset ? photoDescriptor(asset) : null,
    chunks: entry.provider === 'gridfs' && !asset ? await chunkStatus(entry) : [] });
}));
router.put('/sessions/:id/assets/:assetId/chunks/:n', express.raw({ type: 'application/octet-stream', limit: CHUNK_BYTES }), route(async (req, res) => {
  const { entry } = await getEntry(req.params.id, token(req), req.params.assetId);
  await writeChunk(entry, Number(req.params.n), req.body);
  res.json({ success: true });
}));
router.post('/sessions/:id/assets/:assetId/complete', route(async (req, res) => {
  const { entry } = await getEntry(req.params.id, token(req), req.params.assetId);
  res.json({ success: true, photo: photoDescriptor(await completePhoto(req.params.id, entry)) });
}));
router.delete('/sessions/:id/assets/:assetId', route(async (req, res) => {
  await removePhoto(req.params.id, token(req), req.params.assetId);
  res.json({ success: true });
}));
router.delete('/sessions/:id/selections/:clientId', route(async (req, res) => {
  await cancelSelection(req.params.id, token(req), req.params.clientId);
  res.json({ success: true });
}));
router.post('/sessions/:id/submit', route(async (req, res) => {
  res.status(201).json(await finalizeSession(req.params.id, token(req), req.body));
}));

router.post('/blob', route(async (req, res) => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw mediaError(503, 'Direct photo storage is not configured');
  const result = await handleUpload({ request: req, body: req.body,
    onBeforeGenerateToken: async (pathname, payload) => {
      const { sessionId, token: uploadToken, assetId } = JSON.parse(payload || '{}');
      const { entry } = await getEntry(sessionId, uploadToken, assetId);
      if (entry.provider !== 'blob' || pathname !== blobPath(assetId)) throw mediaError(400, 'Invalid photo destination');
      return { allowedContentTypes: [entry.contentType], maximumSizeInBytes: entry.size,
        validUntil: Date.now() + 30 * 60000, addRandomSuffix: false, allowOverwrite: false,
        tokenPayload: JSON.stringify({ sessionId, assetId }) };
    },
    onUploadCompleted: async ({ tokenPayload }) => {
      const { sessionId, assetId } = JSON.parse(tokenPayload || '{}');
      const session = await UploadSession.findById(sessionId).lean();
      const entry = session?.entries.find((e) => e._id === assetId && !e.removedAt);
      if (entry && session.state === 'open' && session.expiresAt > new Date()) await completePhoto(sessionId, entry);
    },
  });
  res.json(result);
}));

async function serveAsset(req, res, thumbnail) {
  const asset = await MediaAsset.findById(req.params.assetId).lean();
  if (!asset) throw mediaError(404, 'Photo not found');
  if (thumbnail && !asset.thumbnailId) {
    // Avoid fetching full-resolution originals for a pending or unsupported preview.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', '10');
    return res.status(404).json({ message: 'Preview is being prepared' });
  }
  const stream = thumbnail
    ? new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'mediaDerivatives' })
      .openDownloadStream(new mongoose.Types.ObjectId(asset.thumbnailId))
    : await openAssetStream(asset);
  res.setHeader('Content-Type', thumbnail ? 'image/webp' : asset.contentType);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  if (!thumbnail) res.setHeader('Content-Length', asset.size);
  res.on('close', () => stream.destroy());
  await pipeline(stream, res);
}
router.get('/assets/:assetId', route((req, res) => serveAsset(req, res, false)));
router.get('/assets/:assetId/thumbnail', route((req, res) => serveAsset(req, res, true)));
router.use((err, req, res, next) => respondMediaError(req, res, err));
export default router;
