import { privateDraftStorage } from './privateDraftStorage.js';
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

export const streamDraftPdf = (res) => res.status(403).json({ success: false, message: 'Original magazine files are restricted. Use the protected book reader.' });

// Internal range access only: no endpoint exposes the original PDF.
export async function draftRangeSource(draft) {
  if (draft.storageProvider === 'blob') {
    const info = await privateDraftStorage.inspect(draft.blobPath);
    return { length: info.size, read: (start,end,signal) => Readable.from((async function*(){ const source=await privateDraftStorage.range(draft.blobPath,start,end,signal); try { for await(const chunk of source)yield chunk; }finally{source.destroy();} })()) };
  }
  if (draft.assetId) {
    const file = await mongoose.connection.db.collection('draftFiles.files').findOne({ _id: new mongoose.Types.ObjectId(draft.assetId) });
    if (!file) throw Object.assign(new Error('Draft PDF is unavailable'), { status: 404 });
    return { length: file.length, read: (start, end) => bucket().openDownloadStream(file._id, { start, end }) };
  }
  if (draft.fileUrl?.startsWith('/uploads/drafts/') || draft.fileUrl?.startsWith('/uploads/print/')) {
    const root = path.resolve(process.cwd(), draft.fileUrl.startsWith('/uploads/print/') ? 'uploads/print' : 'uploads/drafts');
    const filename = path.resolve(process.cwd(), draft.fileUrl.slice(1));
    if (!filename.startsWith(root + path.sep)) throw new Error('Invalid legacy draft path');
    const stat = await fs.promises.stat(filename);
    return { length: stat.size, read: (start, end) => fs.createReadStream(filename, { start, end: end - 1 }) };
  }
  throw Object.assign(new Error('Draft PDF is unavailable'), { status: 404 });
}
