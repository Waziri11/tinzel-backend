import express from 'express';
import { verifyStaffToken } from '../middlewares/auth.middleware.js';
import { FILE_CHUNK_BYTES, reserveFileUpload, ownedFileUpload, describeFileUpload, putFileChunk, completeFileUpload } from '../services/fileUploadService.js';
const router = express.Router();
const route = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };
router.use(verifyStaffToken, (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
router.post('/', route(async (req, res) => res.status(201).json(await reserveFileUpload(req.user, req.body))));
router.get('/:uploadId', route(async (req, res) => res.json(await describeFileUpload(await ownedFileUpload(req.user, req.params.uploadId)))));
router.put('/:uploadId/chunks/:n', express.raw({ type: 'application/octet-stream', limit: FILE_CHUNK_BYTES }), route(async (req, res) => {
  await putFileChunk(await ownedFileUpload(req.user, req.params.uploadId), Number(req.params.n), req.body, req.get('X-Chunk-SHA256'));
  res.json({ success: true });
}));
router.post('/:uploadId/complete', route(async (req, res) => res.json(await completeFileUpload(await ownedFileUpload(req.user, req.params.uploadId)))));
export default router;
