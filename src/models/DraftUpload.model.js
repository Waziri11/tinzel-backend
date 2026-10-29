import mongoose from 'mongoose';
export const DraftUpload = mongoose.model('DraftUpload', new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  staffId: { type: mongoose.Schema.Types.ObjectId, required: true },
  assetId: { type: mongoose.Schema.Types.ObjectId, required: true },
  name: String, size: Number, fingerprint: String,
  expectedVersion: Number, designerNotes: String, revisionRequestId: String, verifyAll: Boolean,
  state: { type: String, default: 'open' }, leaseUntil: Date,
  expiresAt: { type: Date, index: true }, version: Number,
}, { timestamps: true }));
