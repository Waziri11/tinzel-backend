import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const staffUserSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Staff name is required'],
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'Staff email is required'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: ['admin', 'manager', 'designer'],
      required: true,
      default: 'designer',
    },
    preferredLanguage: { type: String, enum: ['en', 'sw'], default: 'sw' },
    phone: {
      type: String,
      trim: true,
      default: '',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    // Workload controls for designers
    isEligibleForAssignment: {
      type: Boolean,
      default: true,
    },
    maxActiveWorkload: {
      type: Number,
      default: 5,
    },
    currentActiveWorkload: {
      type: Number,
      default: 0,
    },
    mustChangePassword: { type: Boolean, default: false },
    temporaryPasswordExpiresAt: { type: Date, default: null },
    passwordChangedAt: Date,
    credentialGeneration: { type: Number, default: 0 },
    credentialDelivery: { type: mongoose.Schema.Types.Mixed, default: {} },
    credentialJob: { type: mongoose.Schema.Types.Mixed, default: null, select: false },
    tokenVersion: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
  }
);

staffUserSchema.index({ 'credentialJob.state': 1, 'credentialJob.runAfter': 1 });
for (const format of ['toJSON','toObject']) staffUserSchema.set(format,{transform:(_doc,ret)=>{delete ret.passwordHash;delete ret.credentialJob;return ret;}});

staffUserSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.passwordHash);
};

export const StaffUser = mongoose.model('StaffUser', staffUserSchema);
