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
  },
  {
    timestamps: true,
  }
);

staffUserSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.passwordHash);
};

export const StaffUser = mongoose.model('StaffUser', staffUserSchema);
