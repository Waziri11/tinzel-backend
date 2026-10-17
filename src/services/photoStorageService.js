import mongoose from 'mongoose';

const bucket = () => {
  if (!mongoose.connection.db) throw new Error('Database is not connected');
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'orderPhotos' });
};

export const storeOrderPhoto = (file, meta = {}) =>
  new Promise((resolve, reject) => {
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
        size: file.size,
      })
    );
    upload.end(file.buffer);
  });

export const findOrderPhoto = async (id) => {
  if (!mongoose.isValidObjectId(id)) return null;
  return bucket().find({ _id: new mongoose.Types.ObjectId(id) }).next();
};

export const openOrderPhotoStream = (id) =>
  bucket().openDownloadStream(new mongoose.Types.ObjectId(id));
