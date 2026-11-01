import mongoose from 'mongoose';
const schema = new mongoose.Schema(
  {
    provider: {
      type: String,
      enum: ['nextsms', 'smtp', 'twilio'],
      unique: true,
      required: true,
    },
    values: { type: mongoose.Schema.Types.Mixed, default: {} },
    secrets: { type: mongoose.Schema.Types.Mixed, default: {}, select: false },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser' },
  },
  { timestamps: true, optimisticConcurrency: true },
);
export const ProviderConfig = mongoose.model('ProviderConfig', schema);
