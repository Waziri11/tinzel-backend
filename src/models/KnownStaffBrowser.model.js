import mongoose from 'mongoose';
export const KnownStaffBrowser = mongoose.model('KnownStaffBrowser', new mongoose.Schema({
  _id: String, subjectId: String, fingerprint: String, expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
}, { versionKey: false }));
