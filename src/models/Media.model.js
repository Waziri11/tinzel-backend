import mongoose from 'mongoose';

const entry = new mongoose.Schema({
  _id: String, clientId: String, name: String, size: Number, contentType: String,
  fieldId: String, folderName: String, provider: String, removedAt: Date,
}, { _id: false });

const session = new mongoose.Schema({
  _id: String, tokenHash: String, formId: mongoose.Schema.Types.ObjectId, slug: String,
  entries: { type: [entry], default: [] }, revision: { type: Number, default: 0 },
  cancelledIds: { type: [String], default: [] },
  state: { type: String, default: 'open' }, expiresAt: { type: Date, index: true },
  orderId: mongoose.Schema.Types.ObjectId, auditId: mongoose.Schema.Types.ObjectId,
  finalization: mongoose.Schema.Types.Mixed, result: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

export const UploadSession = mongoose.model('UploadSession', session);
export const MediaAsset = mongoose.model('MediaAsset', new mongoose.Schema({
  _id: String, sessionId: { type: String, index: true }, name: String, size: Number,
  contentType: String, fieldId: String, folderName: String, provider: String,
  blobPath: String, sha256: String, thumbnailId: String, previewError: String,
}, { timestamps: true }));

export const MediaJob = mongoose.model('MediaJob', new mongoose.Schema({
  _id: String, kind: String, assetId: String, orderId: mongoose.Schema.Types.ObjectId,
  version: Number, page: Number, priority: { type: Number, default: 0 }, requested: Boolean,
  folder: String, state: { type: String, default: 'queued' }, attempts: { type: Number, default: 0 },
  errorCode: String, errorReference: String, errorName: String, retryable: Boolean, attemptHistory: { type: [mongoose.Schema.Types.Mixed], default: [] },
  leaseUntil: Date, runAfter: { type: Date, default: Date.now }, owner: String,
  outputId: String, outputIds: { type: [String], default: [] }, error: String, completedAt: Date, lastDownloadAt: Date,
}, { timestamps: true }).index({ kind: 1, state: 1, requested: 1, priority: -1, runAfter: 1, createdAt: 1 }));

export const MediaDownloadTicket = mongoose.model('MediaDownloadTicket', new mongoose.Schema({
  _id: String, staffId: mongoose.Schema.Types.ObjectId, orderId: mongoose.Schema.Types.ObjectId,
  jobId: String, expiresAt: { type: Date, expires: 0 },
}));

export const ProofPage = mongoose.model('ProofPage', new mongoose.Schema({
  orderId: mongoose.Schema.Types.ObjectId, version: Number, page: Number, width: Number, height: Number,
  imageId: mongoose.Schema.Types.ObjectId, format: String, renderVersion: { type: Number, default: 1 }, text: mongoose.Schema.Types.Mixed,
}).index({ orderId: 1, version: 1, page: 1 }, { unique: true }));
