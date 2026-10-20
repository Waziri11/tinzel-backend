export const ACTIVE_ORDER_STATUSES = [
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
  'on_hold',
];

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

export class ManagerWorkflowError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ManagerWorkflowError';
    this.status = status;
  }
}

export const requireStatus = (order, allowed, action) => {
  if (!allowed.includes(order.status)) {
    throw new ManagerWorkflowError(
      `${action} is not available while this order is ${order.status.replace(/_/g, ' ')}.`
    );
  }
};

export const validatePayment = ({ lipaNambaReference, amountPaid }) => {
  const reference = clean(lipaNambaReference);
  const amount = Number(amountPaid);
  if (!reference) throw new ManagerWorkflowError('A genuine Lipa Namba payment reference is required.');
  if (!Number.isFinite(amount) || amount <= 0) throw new ManagerWorkflowError('Amount paid must be greater than zero.');
  return { reference, amount };
};

export const validateDraftDecision = ({ action, feedback, items }) => {
  if (!['release_to_client', 'return_to_designer'].includes(action)) {
    throw new ManagerWorkflowError('Choose whether to release the draft or return it to the designer.');
  }
  const notes = clean(feedback);
  if (action === 'return_to_designer' && !notes && !items?.some((item) => String(item?.text || '').trim())) {
    throw new ManagerWorkflowError('Change instructions are required when returning a draft.');
  }
  return { action, feedback: notes, items };
};

export const validatePrinterStage = ({ stage, notes }) => {
  if (!['in_progress', 'completed'].includes(stage)) {
    throw new ManagerWorkflowError('Choose a valid printing update.');
  }
  const cleanNotes = clean(notes);
  if (!cleanNotes) throw new ManagerWorkflowError('Record the printer reply or verification note.');
  return { stage, notes: cleanNotes };
};

export const validateDispatch = ({ carrier, trackingReference, deliveryAddress, notes }) => {
  const result = {
    carrier: clean(carrier),
    trackingReference: clean(trackingReference),
    deliveryAddress: clean(deliveryAddress),
    notes: clean(notes),
  };
  if (!result.carrier) throw new ManagerWorkflowError('Carrier or delivery service is required.');
  if (!result.trackingReference) throw new ManagerWorkflowError('A genuine waybill or tracking reference is required.');
  if (!result.deliveryAddress) throw new ManagerWorkflowError('Confirm the delivery address before dispatch.');
  return result;
};

export const validateDelivery = ({ recipientName, confirmationMethod, recipientFeedback }) => {
  const result = {
    recipientName: clean(recipientName),
    confirmationMethod: clean(confirmationMethod),
    recipientFeedback: clean(recipientFeedback),
  };
  if (!result.recipientName) throw new ManagerWorkflowError('Recipient name is required.');
  if (!['client_whatsapp', 'courier_proof', 'phone_call', 'in_person'].includes(result.confirmationMethod)) {
    throw new ManagerWorkflowError('Choose how delivery was confirmed.');
  }
  if (!result.recipientFeedback) throw new ManagerWorkflowError('Record the delivery confirmation details.');
  return result;
};

export const isConfiguredPhone = (value) => /^\+[1-9]\d{8,14}$/.test(clean(value));
