import mongoose from 'mongoose';

const bucket = () => {
  if (!mongoose.connection.db) throw new Error('Database is not connected');
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'coverImages' });
};

export const storeCoverImage = (file, uploadedBy) => new Promise((resolve, reject) => {
  const upload = bucket().openUploadStream(file.originalname, {
    contentType: file.mimetype,
    metadata: {
      uploadedBy: uploadedBy ? new mongoose.Types.ObjectId(uploadedBy) : undefined,
      uploadedAt: new Date(),
      purpose: 'magazine_cover',
      contentType: file.mimetype,
    },
  });
  upload.once('error', reject);
  upload.once('finish', () => resolve({ id: upload.id, filename: upload.filename }));
  upload.end(file.buffer);
});

export const findCoverImage = async (id) => {
  if (!mongoose.isValidObjectId(id)) return null;
  return bucket().find({ _id: new mongoose.Types.ObjectId(id) }).next();
};

export const openCoverImageStream = (id) =>
  bucket().openDownloadStream(new mongoose.Types.ObjectId(id));
