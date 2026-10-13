import mongoose from 'mongoose';

const systemConfigSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
    },
    value: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    description: {
      type: String,
      default: '',
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'StaffUser',
    },
  },
  {
    timestamps: true,
  }
);

export const SystemConfig = mongoose.model('SystemConfig', systemConfigSchema);
