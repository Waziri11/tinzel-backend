import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

const createStorage = (subfolder) =>
  multer.diskStorage({
    destination: (req, file, cb) => {
      const dest = path.join(process.cwd(), 'uploads', subfolder);
      ensureDir(dest);
      cb(null, dest);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const uniqueName = `${Date.now()}-${uuidv4().substring(0, 8)}${ext}`;
      cb(null, uniqueName);
    },
  });

const photoFileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|webp|heic/;
  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  const mime = file.mimetype;
  if (allowedTypes.test(ext) || mime.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Invalid image format. Allowed: JPG, PNG, WEBP, HEIC'));
  }
};

const documentFileFilter = (req, file, cb) => {
  const allowed = /pdf|zip|jpeg|jpg|png|webp/;
  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  if (allowed.test(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid document format. Allowed: PDF, ZIP, Images'));
  }
};

export const uploadPhotos = multer({
  // Order photos are persisted to MongoDB GridFS by the route. Memory storage avoids
  // writing to Vercel's read-only /var/task filesystem.
  storage: multer.memoryStorage(),
  fileFilter: photoFileFilter,
  limits: { fileSize: 3500000, fields: 20, parts: 70 },
});

// Legacy multipart uploads must fit the deployment gateway, including metadata.
export const boundPhotoRequest = (req, res, next) => {
  if (!req.is('multipart/form-data')) return next();
  const size = Number(req.headers['content-length']);
  if (!Number.isFinite(size) || size <= 0 || size > 4000000) {
    return res.status(413).json({ success: false, retryable: false,
      message: 'Please refresh the form to upload photos individually using the resumable uploader.' });
  }
  next();
};

export const uploadDraft = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const isPdfName = path.extname(file.originalname).toLowerCase() === '.pdf';
    cb(isPdfName && file.mimetype === 'application/pdf' ? null : new Error('Drafts must be PDF files'), isPdfName && file.mimetype === 'application/pdf');
  },
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB per draft
});

export const uploadPrint = multer({
  storage: createStorage('print'),
  fileFilter: documentFileFilter,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB for print files
});

export const uploadCover = multer({
  // Covers are persisted to MongoDB GridFS by the route. Memory storage avoids
  // writing to Vercel's read-only /var/task filesystem.
  storage: multer.memoryStorage(),
  fileFilter: photoFileFilter,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB for cover images
});
