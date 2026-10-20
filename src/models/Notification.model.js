import mongoose from 'mongoose';

export const NOTIFICATION_CHANNELS = ['whatsapp', 'sms', 'email'];
export const NOTIFICATION_DIRECTIONS = ['outbound', 'inbound'];
export const NOTIFICATION_STATUSES = [
  'queued',
  'sent',
  'delivered',
  'failed',
  'undelivered',
  'received',
];

const notificationSchema = new mongoose.Schema(
  {
    recipient: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    channel: {
      type: String,
      enum: NOTIFICATION_CHANNELS,
      required: true,
      index: true,
    },
    direction: {
      type: String,
      enum: NOTIFICATION_DIRECTIONS,
      default: 'outbound',
      index: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      index: true,
    },
    template: {
      type: String,
      default: 'general',
      index: true,
    },
    subject: {
      type: String,
      default: null,
    },
    message: {
      type: String,
      required: true,
    },
    mediaUrl: {
      type: String,
      default: null,
    },
    twilioSid: {
      type: String,
      index: true,
      sparse: true,
    },
    mode: {
      type: String,
      default: 'simulated',
      index: true,
    },
    status: {
      type: String,
      enum: NOTIFICATION_STATUSES,
      default: 'queued',
      index: true,
    },
    errorCode: {
      type: String,
      default: null,
    },
    errorMessage: {
      type: String,
      default: null,
    },
    fallbackFromChannel: {
      type: String,
      default: null,
    },
    retries: {
      type: Number,
      default: 0,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

notificationSchema.index({ createdAt: -1 });

export const Notification = mongoose.model('Notification', notificationSchema);
