import { randomInt } from 'node:crypto';
import { Counter } from '../models/Counter.model.js';
import { Order } from '../models/Order.model.js';
import { AuditLog } from '../models/AuditLog.model.js';

export const generateSubmissionId = () => {
  const year = new Date().getFullYear();
  const randomPart = randomInt(10000, 100000);
  return `SUB-${year}-${randomPart}`;
};

export const generateUniqueSubmissionId = async () => {
  const year = new Date().getFullYear();
  const isDbReady = Order.db?.readyState === 1;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateSubmissionId();
    if (isDbReady) {
      const exists = await Order.exists({ submissionId: candidate });
      if (!exists) return candidate;
    } else {
      return candidate;
    }
  }
  const fallback = randomInt(100000, 1000000);
  return `SUB-${year}-${fallback}`;
};

export const generateTrackingId = async () => {
  const year = new Date().getFullYear();
  const counterId = `trackingId_${year}`;

  let counter = await Counter.findByIdAndUpdate(
    counterId,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );

  // If counter is 1, check if there are pre-existing orders from before Counter was introduced
  if (counter.seq === 1) {
    const existingOrders = await Order.find({
      trackingId: { $regex: `^TNZ-${year}-\\d+` },
    }).select('trackingId').lean();

    let maxSeq = 0;
    for (const o of existingOrders) {
      const match = o.trackingId?.match(new RegExp(`^TNZ-${year}-(\\d+)`));
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxSeq) maxSeq = num;
      }
    }

    if (maxSeq >= 1) {
      counter = await Counter.findByIdAndUpdate(
        counterId,
        { $set: { seq: maxSeq + 1 } },
        { new: true }
      );
    }
  }

  const sequence = String(counter.seq).padStart(4, '0');
  return `TNZ-${year}-${sequence}`;
};

/**
 * Validates whether an order status transition is permissible according to PRD Conveyor Belt rules.
 */
export const validateTransition = (currentStatus, targetStatus) => {
  const allowedTransitions = {
    awaiting_payment: ['payment_verified', 'on_hold', 'closed'],
    payment_verified: ['assigned', 'queued_for_assignment', 'on_hold'],
    queued_for_assignment: ['assigned', 'on_hold'],
    assigned: ['in_design', 'queued_for_assignment', 'on_hold'],
    in_design: ['draft_manager_review', 'on_hold'],
    draft_manager_review: ['client_review', 'in_design', 'on_hold'],
    client_review: ['client_approved', 'revision_requested', 'on_hold'],
    revision_requested: ['in_design', 'on_hold'],
    client_approved: ['print_document_prep', 'on_hold'],
    print_document_prep: ['print_manager_review', 'on_hold'],
    print_manager_review: ['printing_sent', 'print_document_prep', 'on_hold'],
    printing_sent: ['printing_in_progress', 'on_hold'],
    printing_in_progress: ['printing_completed', 'on_hold'],
    printing_completed: ['dispatched', 'on_hold'],
    dispatched: ['delivered', 'on_hold'],
    delivered: ['closed', 'on_hold'],
    closed: [],
    on_hold: ['awaiting_payment', 'in_design', 'client_review', 'printing_sent', 'dispatched'],
  };

  const allowed = allowedTransitions[currentStatus] || [];
  return allowed.includes(targetStatus);
};

/**
 * Sanitizes order payload for client view using an explicit allowlist of client-safe fields,
 * ensuring unreleased drafts, assignmentHistory, printDocument URLs, and internal staff metadata are never exposed.
 */
export const sanitizeOrderForClient = (order) => {
  const obj = order.toObject ? order.toObject() : { ...order };

  const draftVersions = (obj.draftVersions || [])
    .filter((v) => v.managerReview?.status === 'approved')
    .map((v) => ({
      _id: v._id,
      versionNumber: v.versionNumber,
      uploadedAt: v.uploadedAt,
      designerNotes: v.designerNotes || '',
      managerReview: {
        status: v.managerReview.status,
        reviewedAt: v.managerReview.reviewedAt,
      },
      clientReview: v.clientReview,
    }));

  const revisionRequests = (obj.revisionRequests || [])
    .filter((request) => request.source === 'client')
    .map((request) => ({
      _id: request._id,
      roundNumber: request.roundNumber,
      draftVersionNumber: request.draftVersionNumber,
      status: request.status,
      requestedAt: request.requestedAt,
      resolvedAt: request.resolvedAt,
      items: (request.items || []).map((item) => ({
        _id: item._id,
        annotationId: item.annotationId,
        text: item.text,
        pageReference: item.pageReference,
        status: item.status,
      })),
    }));

  const dispatchDetails = obj.dispatchDetails
    ? {
        carrier: obj.dispatchDetails.carrier || '',
        trackingReference: obj.dispatchDetails.trackingReference || '',
        dispatchedAt: obj.dispatchDetails.dispatchedAt || null,
      }
    : undefined;

  const deliveryDetails = obj.deliveryDetails
    ? {
        deliveredAt: obj.deliveryDetails.deliveredAt || null,
        recipientName: obj.deliveryDetails.recipientName || '',
      }
    : undefined;

  return {
    _id: obj._id,
    submissionId: obj.submissionId,
    trackingId: obj.trackingId,
    formId: obj.formId,
    formTitle: obj.formTitle,
    clientName: obj.clientName,
    clientWhatsApp: obj.clientWhatsApp,
    clientEmail: obj.clientEmail,
    clientPreferredLanguage: obj.clientPreferredLanguage || 'sw',
    status: obj.status,
    previousStatusBeforeHold: obj.previousStatusBeforeHold,
    holdReason: obj.holdReason,
    price: obj.formId?.price ?? obj.price,
    currency: obj.formId?.currency ?? obj.currency ?? 'TZS',
    lipaNambaInstructions: obj.formId?.lipaNambaInstructions ?? null,
    submittedData: obj.submittedData,
    submittedFields: obj.submittedFields,
    uploadedPhotos: obj.uploadedPhotos,
    currentDraftVersion: obj.currentDraftVersion,
    approvedVersionNumber: obj.approvedVersionNumber,
    draftVersions,
    revisionRequests,
    ...(dispatchDetails ? { dispatchDetails } : {}),
    ...(deliveryDetails ? { deliveryDetails } : {}),
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };
};
