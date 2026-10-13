import mongoose from 'mongoose';

export const ORDER_STATUSES = [
  'awaiting_payment',
  'payment_verified',
  'queued_for_assignment',
  'assigned',
  'in_design',
  'draft_manager_review',
  'client_review',
  'revision_requested',
  'client_approved',
  'print_document_prep',
  'print_manager_review',
  'printing_sent',
  'printing_in_progress',
  'printing_completed',
  'dispatched',
  'delivered',
  'closed',
  'on_hold',
];

const draftVersionSchema = new mongoose.Schema(
  {
    versionNumber: {
      type: Number,
      required: true,
    },
    fileUrl: {
      type: String,
      required: true,
    },
    previewPages: {
      type: [String],
      default: [],
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'StaffUser',
    },
    uploadedAt: {
      type: Date,
      default: Date.now,
    },
    designerNotes: {
      type: String,
      default: '',
    },
    managerReview: {
      status: {
        type: String,
        enum: ['pending', 'approved', 'returned'],
        default: 'pending',
      },
      reviewedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'StaffUser',
      },
      reviewedAt: Date,
      feedback: String,
    },
    clientReview: {
      status: {
        type: String,
        enum: ['pending', 'approved', 'revision_requested'],
        default: 'pending',
      },
      reviewedAt: Date,
      feedback: String,
    },
  },
  { _id: true }
);

const orderSchema = new mongoose.Schema(
  {
    submissionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    trackingId: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    formId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MagazineForm',
      required: true,
    },
    formTitle: {
      type: String,
      default: '',
    },
    clientName: {
      type: String,
      required: true,
      trim: true,
    },
    clientWhatsApp: {
      type: String,
      required: true,
      trim: true,
    },
    clientEmail: {
      type: String,
      trim: true,
      default: '',
    },
    submittedData: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    uploadedPhotos: [
      {
        url: String,
        originalName: String,
        size: Number,
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    status: {
      type: String,
      enum: ORDER_STATUSES,
      default: 'awaiting_payment',
      index: true,
    },
    paymentDetails: {
      verifiedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'StaffUser',
      },
      verifiedAt: Date,
      lipaNambaReference: String,
      amountPaid: Number,
      receiptNumber: String,
    },
    assignedDesigner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'StaffUser',
    },
    assignmentHistory: [
      {
        designerId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'StaffUser',
        },
        designerName: String,
        assignedAt: { type: Date, default: Date.now },
        assignedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'StaffUser',
        },
        reason: String,
      },
    ],
    holdReason: {
      type: String,
      default: '',
    },
    previousStatusBeforeHold: {
      type: String,
    },
    draftVersions: [draftVersionSchema],
    currentDraftVersion: {
      type: Number,
      default: 0,
    },
    approvedVersionNumber: {
      type: Number,
    },
    printDocument: {
      url: String,
      uploadedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'StaffUser',
      },
      uploadedAt: Date,
      managerAuthorisedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'StaffUser',
      },
      managerAuthorisedAt: Date,
      specs: {
        quantity: { type: Number, default: 1 },
        paperType: { type: String, default: 'Glossy 150gsm' },
        coverFinish: { type: String, default: 'Laminated Matte' },
        binding: { type: String, default: 'Saddle Stitch' },
      },
    },
    printingDetails: {
      sentAt: Date,
      printerPhone: String,
      acknowledgedAt: Date,
      completedAt: Date,
      managerVerifiedAt: Date,
      notes: String,
    },
    dispatchDetails: {
      authorisedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'StaffUser',
      },
      authorisedAt: Date,
      carrier: { type: String, default: '' },
      trackingReference: { type: String, default: '' },
      deliveryAddress: { type: String, default: '' },
      notes: String,
    },
    deliveryDetails: {
      confirmedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'StaffUser',
      },
      confirmedAt: Date,
      recipientFeedback: String,
    },
    otp: {
      code: String,
      expiresAt: Date,
      attempts: { type: Number, default: 0 },
    },
  },
  {
    timestamps: true,
  }
);

export const Order = mongoose.model('Order', orderSchema);
