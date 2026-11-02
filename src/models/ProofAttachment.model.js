import mongoose from 'mongoose';

export const ProofAttachment = mongoose.model('ProofAttachment', new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, required: true },
  version: Number, source: String, authorId: String, clientId: String,
  name: String, size: Number, contentType: String,
  state: { type: String, default: 'uploading' },
  imageId: mongoose.Schema.Types.ObjectId, thumbnailId: mongoose.Schema.Types.ObjectId,
  annotationId: mongoose.Schema.Types.ObjectId, width: Number, height: Number,
  expiresAt: Date, processingUntil: Date,
}, { timestamps: true }).index({ orderId: 1, version: 1, source: 1, authorId: 1, clientId: 1 }, { unique: true })
  .index({ expiresAt: 1 }));
