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
    storageProvider: String, blobPath: String,
    fileUrl: { type: String, default: '' },
    uploadSessionId: { type: mongoose.Schema.Types.ObjectId },
    assetId: { type: mongoose.Schema.Types.ObjectId },
    originalName: { type: String, default: '' },
    mimeType: { type: String, default: 'application/pdf' },
    size: { type: Number, default: 0 },
    revisionRequestId: { type: mongoose.Schema.Types.ObjectId },
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

const proofAnnotationSchema = new mongoose.Schema({
  clientMutationId: String,
  version: Number, page: Number, kind: { type: String, enum: ['text', 'area', 'image'] },
  rects: [{ x: Number, y: Number, width: Number, height: Number, _id: false }],
  imageRegionId: String, imageQuad: [{x:Number,y:Number,_id:false}],
  selectedText: String, text: String, source: { type: String, enum: ['manager', 'client'] },
  authorId: String, authorName: String, createdAt: { type: Date, default: Date.now }, submittedAt: Date,
});

const correctionItemSchema = new mongoose.Schema({
  text: { type: String, required: true, trim: true },
  annotationId: mongoose.Schema.Types.ObjectId,
  pageReference: { type: String, default: '', trim: true },
  status: { type: String, enum: ['open', 'addressed'], default: 'open' },
  designerResponse: { type: String, default: '', trim: true },
  addressedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffUser' },
  addressedAt: Date,
}, { _id: true });

const revisionRequestSchema = new mongoose.Schema({
  roundNumber: { type: Number, required: true },
  draftVersionNumber: { type: Number, required: true },
  source: { type: String, enum: ['manager', 'client'], required: true },
  status: { type: String, enum: ['open', 'submitted_for_review', 'resolved'], default: 'open' },
  requestedBy: {
    type: { type: String, enum: ['manager', 'admin', 'client'], required: true },
    id: String,
    name: { type: String, default: '' },
  },
  requestedAt: { type: Date, default: Date.now },
  items: { type: [correctionItemSchema], default: [] },
  submittedVersionNumber: Number,
  submittedAt: Date,
  resolvedAt: Date,
  resolution: { type: String, enum: ['released', 'returned', 'legacy'], default: undefined },
}, { _id: true });

const orderSchema = new mongoose.Schema(
  {
    mediaSessionId: { type: String, unique: true, sparse: true },
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
    submittedFields: [{
      fieldId: String,
      label: String,
      sectionId: String,
      order: Number,
    }],
    uploadedPhotos: [
      {
        url: String,
        assetId: String,
        thumbnailUrl: String,
        originalName: String,
        size: Number,
        fieldId: { type: String, default: '' },
        folderName: { type: String, default: 'General Photos' },
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
    draftEvents: { type: [new mongoose.Schema({ key: String, version: Number, state: String, actor: mongoose.Schema.Types.Mixed, createdAt: Date, completedAt: Date, attempts: Number, owner: String, leaseUntil: Date, runAfter: Date, error: String }, { _id: false })], default: [] },
    proofAnnotations: { type: [proofAnnotationSchema], default: [] },
    revisionRequests: { type: [revisionRequestSchema], default: [] },
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
      recipientName: String,
      confirmationMethod: {
        type: String,
        enum: ['client_whatsapp', 'courier_proof', 'phone_call', 'in_person'],
      },
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
    optimisticConcurrency: true,
  }
);

orderSchema.index({ status: 1, updatedAt: -1 });
orderSchema.index({ assignedDesigner: 1, status: 1, updatedAt: -1 });
orderSchema.index({ assignedDesigner: 1, updatedAt: -1 });
orderSchema.index({ updatedAt: -1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ 'draftEvents.state': 1, 'draftEvents.nextAttemptAt': 1 });
orderSchema.index({ clientName: 1 });

export const Order = mongoose.model('Order', orderSchema);
