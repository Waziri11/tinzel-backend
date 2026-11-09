import mongoose from 'mongoose';
import { assertNoActiveImageContent } from './uploadService.js';

const bucket = () => {
  if (!mongoose.connection.db) throw new Error('Database is not connected');
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'coverImages' });
};

export const storeCoverImage = async (file, uploadedBy) => {
  const rawBuffer = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer || []);
  assertNoActiveImageContent(rawBuffer);

  const buffer = rawBuffer;
  const contentType = file.mimetype || 'image/webp';
  const filename = file.originalname || 'cover.webp';

  return new Promise((resolve, reject) => {
    const upload = bucket().openUploadStream(filename, {
      contentType,
      metadata: {
        uploadedBy: uploadedBy ? new mongoose.Types.ObjectId(uploadedBy) : undefined,
        uploadedAt: new Date(),
        purpose: 'magazine_cover',
        contentType,
        originalSize: file.size || file.buffer?.length || 0,
      },
    });
    upload.once('error', reject);
    upload.once('finish', () => resolve({ id: upload.id, filename: upload.filename, size: buffer.length, contentType }));
    upload.end(buffer);
  });
};

export const findCoverImage = async (id) => {
  if (!mongoose.isValidObjectId(id)) return null;
  return bucket().find({ _id: new mongoose.Types.ObjectId(id) }).next();
};

export const openCoverImageStream = (id) =>
  bucket().openDownloadStream(new mongoose.Types.ObjectId(id));
