import mongoose from 'mongoose';

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

const writePhotoOnce = (file, meta = {}) =>
  new Promise((resolve, reject) => {
    const buffer = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer || []);
    const upload = bucket().openUploadStream(file.originalname || 'photo.jpg', {
      contentType: file.mimetype || 'image/jpeg',
      metadata: {
        uploadedAt: new Date(),
        purpose: 'order_photo',
        contentType: file.mimetype || 'image/jpeg',
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

export const storeOrderPhoto = async (file, meta = {}) => {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await writePhotoOnce(file, meta);
    } catch (err) {
      lastError = err;
      // Reset cached bucket in case of transient index/collection initialization conflict
      cachedBucket = null;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
  throw lastError;
};

export const findOrderPhoto = async (id) => {
  if (!mongoose.isValidObjectId(id)) return null;
  return bucket().find({ _id: new mongoose.Types.ObjectId(id) }).next();
};

export const openOrderPhotoStream = (id) =>
  bucket().openDownloadStream(new mongoose.Types.ObjectId(id));
