import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import mongoose from 'mongoose';

const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'draftFiles' });

export const isPdf = (file) => Boolean(
  file &&
  path.extname(file.originalname || '').toLowerCase() === '.pdf' &&
  file.mimetype === 'application/pdf' &&
  file.buffer?.subarray(0, 5).toString() === '%PDF-'
);

export const saveDraftPdf = (file, orderId, versionNumber) => new Promise((resolve, reject) => {
  const upload = bucket().openUploadStream(file.originalname, {
    contentType: 'application/pdf',
    metadata: { orderId: String(orderId), versionNumber },
  });
  upload.once('error', reject);
  upload.once('finish', () => resolve(upload.id));
  Readable.from(file.buffer).pipe(upload);
});

export const deleteDraftPdf = async (assetId) => {
  if (!assetId) return;
  try { await bucket().delete(new mongoose.Types.ObjectId(assetId)); } catch (error) {
    if (error?.code !== 26) throw error;
  }
};

export const openDraftPdf = (draft) => {
  if (draft.assetId) return bucket().openDownloadStream(new mongoose.Types.ObjectId(draft.assetId));
  if (draft.fileUrl?.startsWith('/uploads/drafts/')) {
    const filePath = path.join(process.cwd(), draft.fileUrl.replace(/^\//, ''));
    if (fs.existsSync(filePath)) return fs.createReadStream(filePath);
  }
  const error = new Error('Draft PDF is unavailable');
  error.status = 404;
  throw error;
};

export const streamDraftPdf = (res, draft, { download = false } = {}) => {
  const filename = (draft.originalName || `magazine-v${draft.versionNumber}.pdf`).replace(/["\r\n]/g, '');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const stream = openDraftPdf(draft);
  stream.on('error', (error) => { if (!res.headersSent) res.status(error.status || 404).json({ success: false, message: error.message }); else res.destroy(error); });
  stream.pipe(res);
};
