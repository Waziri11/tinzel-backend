import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  _id: String,
  subjectId: { type: String, required: true, index: true },
  role: String,
  browser: String,
  tokenVersion: Number,
  contactFingerprint: String,
  verifiedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
}, { versionKey: false });

export const TrustedStaffDevice = mongoose.model('TrustedStaffDevice', schema);
