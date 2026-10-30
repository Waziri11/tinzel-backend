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

const ALLOWED_RASTER_EXT = /^(jpe?g|png|webp|heic|heif|avif|gif)$/i;
const ALLOWED_RASTER_MIME = /^image\/(jpeg|jpg|png|webp|heic|heif|avif|gif)$/i;
const ACTIVE_CONTENT_PATTERN = /<\s*(svg|\?xml|!doctype|html|script|iframe|object|embed)\b|onload\s*=|onerror\s*=|javascript:/i;

export function assertNoActiveImageContent(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    const err = new Error('Image file is empty');
    err.status = 400;
    throw err;
  }
  const headText = buffer.subarray(0, Math.min(buffer.length, 1024)).toString('utf8');
  if (ACTIVE_CONTENT_PATTERN.test(headText)) {
    const err = new Error('Active or SVG image content is not permitted. Upload a raster image (JPG, PNG, WebP, HEIC).');
    err.status = 400;
    throw err;
  }
}

const photoFileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || '').toLowerCase().replace('.', '');
  const mime = String(file.mimetype || '').toLowerCase();
  if (
    ext === 'svg' ||
    mime.includes('svg') ||
    mime.includes('xml') ||
    mime.includes('html') ||
    !ALLOWED_RASTER_EXT.test(ext) ||
    !ALLOWED_RASTER_MIME.test(mime)
  ) {
    const err = new Error('Invalid image format. Allowed raster formats: JPG, PNG, WEBP, HEIC');
    err.status = 400;
    return cb(err, false);
  }
  return cb(null, true);
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
  // Memory storage + GridFS persistence avoids writing to Vercel's read-only /var/task filesystem.
  storage: multer.memoryStorage(),
  fileFilter: documentFileFilter,
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB cap for single-request uploads; larger print PDFs use resumable sessions
});

export const uploadCover = multer({
  // Covers are persisted to MongoDB GridFS by the route. Memory storage avoids
  // writing to Vercel's read-only /var/task filesystem, and 4MB fits Vercel's 4.5MB gateway limit.
  storage: multer.memoryStorage(),
  fileFilter: photoFileFilter,
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB for cover images (client + server WebP optimization)
});
