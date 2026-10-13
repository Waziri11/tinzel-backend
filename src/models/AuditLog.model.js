import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema(
  {
    actor: {
      type: {
        type: String,
        enum: ['client', 'manager', 'designer', 'admin', 'system'],
        required: true,
      },
      id: {
        type: String,
      },
      name: {
        type: String,
        default: 'System',
      },
    },
    action: {
      type: String,
      required: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      index: true,
    },
    details: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    ipAddress: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
