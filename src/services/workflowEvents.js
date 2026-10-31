import { randomUUID } from 'node:crypto';

export const STATUS_EVENTS = {
  awaiting_payment: 'order_submitted', payment_verified: 'payment_verified', queued_for_assignment: 'assignment_queued', assigned: 'order_assigned',
  draft_manager_review: 'draft_uploaded', client_review: 'draft_released', revision_requested: 'draft_returned',
  client_approved: 'client_approved', print_manager_review: 'print_document_uploaded', printing_sent: 'print_dispatched',
  printing_in_progress: 'printing_in_progress', printing_completed: 'printing_completed', dispatched: 'order_dispatched', closed: 'order_closed',
};
const identity = value => String(value?._id || value || '');
export function workflowEvent(order, type, key = randomUUID()) {
  const revision = order.revisionRequests?.at(-1);
  return { key, type, state: 'pending', createdAt: new Date(), version: order.currentDraftVersion || 0,
    designerId: identity(order.assignedDesigner), revisionId: identity(revision), source: revision?.source,
    printPath: order.printDocument?.url || null,
    printUploadedAt: order.printDocument?.uploadedAt?.toISOString?.() || null,
    status: order.status, baseUrl: order.$locals?.notificationBaseUrl || '', tasks: null };
}
export function installWorkflowEvents(schema) {
  const remember = doc => { doc.$locals.workflowBefore = { status: doc.status, designerId: identity(doc.assignedDesigner) }; };
  schema.post('init', remember);
  schema.pre('save', function () {
    const before = this.$locals.workflowBefore;
    let type = this.isNew ? (this.status === 'awaiting_payment' ? 'order_submitted' : null)
      : before && before.status !== this.status ? STATUS_EVENTS[this.status] : null;
    if (!this.isNew && before && before.designerId !== identity(this.assignedDesigner) && this.assignedDesigner) type = 'order_assigned';
    // Keep a stable key if a failed save is retried on the same document.
    if (type && !this.$locals.pendingWorkflowKey) {
      const event = workflowEvent(this, type);
      this.workflowEvents.push(event); this.$locals.pendingWorkflowKey = event.key;
    }
  });
  schema.post('save', function () { remember(this); delete this.$locals.pendingWorkflowKey; });
}
