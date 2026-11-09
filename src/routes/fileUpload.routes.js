import express from 'express';
import { verifyStaffToken } from '../middlewares/auth.middleware.js';
import { FILE_CHUNK_BYTES, fileChunkBytes, reserveFileUpload, ownedFileUpload, describeFileUpload, putFileChunk, completeFileUpload, uploadWholeFile } from '../services/fileUploadService.js';
import { MAX_UPLOAD_BATCH_BYTES, readUploadMetadata, writeUploadBatch } from '../services/uploadBatchService.js';
const router = express.Router();
const route = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };
router.use(verifyStaffToken, (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
router.put('/whole', express.raw({ type: 'application/octet-stream', limit: MAX_UPLOAD_BATCH_BYTES }), route(async (req, res) => {
  res.json(await uploadWholeFile(req.user, readUploadMetadata(req.get('X-Upload-Metadata')), req.body, req.get('X-Chunk-SHA256')));
}));
router.post('/', route(async (req, res) => res.status(201).json(await reserveFileUpload(req.user, req.body))));
router.get('/:uploadId', route(async (req, res) => res.json(await describeFileUpload(await ownedFileUpload(req.user, req.params.uploadId)))));
router.put('/:uploadId/chunks/:n', express.raw({ type: 'application/octet-stream', limit: FILE_CHUNK_BYTES }), route(async (req, res) => {
  await putFileChunk(await ownedFileUpload(req.user, req.params.uploadId), Number(req.params.n), req.body, req.get('X-Chunk-SHA256'));
  res.json({ success: true });
}));
router.put('/:uploadId/batches/:n', express.raw({ type: 'application/octet-stream', limit: MAX_UPLOAD_BATCH_BYTES }), route(async (req, res) => {
  const session = await ownedFileUpload(req.user, req.params.uploadId);
  await writeUploadBatch({ bytes: req.body, start: Number(req.params.n), size: session.size, chunkBytes: fileChunkBytes(session),
    expectedHash: req.get('X-Chunk-SHA256'), write: (n, bytes, hash) => putFileChunk(session, n, bytes, hash) });
  res.json({ success: true });
}));
router.post('/:uploadId/complete', route(async (req, res) => res.json(await completeFileUpload(await ownedFileUpload(req.user, req.params.uploadId)))));
export default router;
