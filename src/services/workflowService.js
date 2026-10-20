import { Order } from '../models/Order.model.js';
import { AuditLog } from '../models/AuditLog.model.js';

export const generateSubmissionId = () => {
  const year = new Date().getFullYear();
  const randomPart = Math.floor(10000 + Math.random() * 90000);
  return `SUB-${year}-${randomPart}`;
};

export const generateTrackingId = async () => {
  const year = new Date().getFullYear();
  // Count existing tracking IDs for this year to create sequential sequence
  const count = await Order.countDocuments({
    trackingId: { $regex: `^TNZ-${year}-` },
  });
  const sequence = String(count + 1).padStart(4, '0');
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
 * Sanitizes order payload for client view, ensuring unreleased drafts are stripped.
 */
export const sanitizeOrderForClient = (order) => {
  const obj = order.toObject ? order.toObject() : { ...order };

  // Only expose draft versions if current status has passed manager review release gate
  const clientCanSeeDraft = [
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
  ].includes(obj.status);

  if (!clientCanSeeDraft) {
    obj.draftVersions = [];
  } else {
    // Only the current manager-approved version is client-visible; storage identifiers never leave the API.
    obj.draftVersions = obj.draftVersions.filter(
      (v) => v.versionNumber === obj.currentDraftVersion && v.managerReview?.status === 'approved'
    ).map((v) => ({
      _id: v._id,
      versionNumber: v.versionNumber,
      uploadedAt: v.uploadedAt,
      managerReview: { status: v.managerReview.status, reviewedAt: v.managerReview.reviewedAt },
      clientReview: v.clientReview,
    }));
  }

  obj.revisionRequests = (obj.revisionRequests || [])
    .filter((request) => request.source === 'client')
    .map((request) => ({
      _id: request._id, roundNumber: request.roundNumber, draftVersionNumber: request.draftVersionNumber,
      status: request.status, requestedAt: request.requestedAt, resolvedAt: request.resolvedAt,
      items: (request.items || []).map((item) => ({ _id: item._id, text: item.text, pageReference: item.pageReference, status: item.status })),
    }));

  // Remove internal OTP details and internal staff identifiers
  delete obj.otp;
  delete obj.__v;
  delete obj.assignedDesigner;

  return obj;
};
