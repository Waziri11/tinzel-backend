import mongoose from 'mongoose';
import sharp from 'sharp';
import { assertNoActiveImageContent } from './uploadService.js';

let cachedDb = null;
let cachedBucket = null;

const bucket = () => {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database is not connected');
  if (cachedBucket && cachedDb === db) {
    return cachedBucket;
  }
  cachedDb = db;
  cachedBucket = new mongoose.mongo.GridFSBucket(db, { bucketName: 'orderPhotos' });
  return cachedBucket;
};

export const storeOrderPhoto = async (file, meta = {}) => {
  const rawBuffer = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer || []);
  assertNoActiveImageContent(rawBuffer);

  let buffer = rawBuffer;
  let contentType = file.mimetype || 'image/jpeg';

  try {
    const metadata = await sharp(rawBuffer, { limitInputPixels: 60000000 }).metadata();
    if (metadata.format === 'svg') {
      const err = new Error('SVG images are not permitted');
      err.status = 400;
      throw err;
    }
    if (metadata.format === 'png') {
      buffer = await sharp(rawBuffer, { limitInputPixels: 60000000 }).rotate().png().toBuffer();
      contentType = 'image/png';
    } else if (metadata.format === 'webp') {
      buffer = await sharp(rawBuffer, { limitInputPixels: 60000000 }).rotate().webp({ quality: 90 }).toBuffer();
      contentType = 'image/webp';
    } else if (metadata.format === 'jpeg' || metadata.format === 'jpg') {
      buffer = await sharp(rawBuffer, { limitInputPixels: 60000000 }).rotate().jpeg({ quality: 90 }).toBuffer();
      contentType = 'image/jpeg';
    }
  } catch (err) {
    if (err.status === 400) throw err;
  }

  return new Promise((resolve, reject) => {
    const upload = bucket().openUploadStream(file.originalname || 'photo.jpg', {
      timeoutMS: 20000,
      contentType,
      metadata: {
        uploadedAt: new Date(),
        purpose: 'order_photo',
        contentType,
        fieldId: meta.fieldId || '',
        folderName: meta.folderName || 'General Photos',
        formSlug: meta.formSlug || '',
      },
    });
    upload.once('error', reject);
    upload.once('finish', () =>
      resolve({
        id: String(upload.id),
        filename: upload.filename,
        size: buffer.length,
      })
    );
    upload.end(buffer);
  });
};

export const findOrderPhoto = async (id) => {
  if (!mongoose.isValidObjectId(id)) return null;
  return bucket().find({ _id: new mongoose.Types.ObjectId(id) }).next();
};

export const openOrderPhotoStream = (id) =>
  bucket().openDownloadStream(new mongoose.Types.ObjectId(id));
