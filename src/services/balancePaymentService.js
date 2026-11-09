import { paymentSummary, snapshotOrderPrice, BEFORE_PRINT_STATUSES } from './paymentPolicy.js';

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const sameReference = (a, b) => String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase();

function validateInput(input) {
  const reference = typeof input.reference === 'string' ? input.reference.trim() : '';
  const amount = Number(input.amount);
  if (!reference || reference.length > 120) throw fail('Enter a payment reference of up to 120 characters.', 400);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(Math.round(amount * 100)) || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.00001) throw fail('Enter a valid payment amount with at most two decimal places.', 400);
  return { reference, amount: Math.round(amount * 100) / 100 };
}

function requireBalanceStage(order) {
  if (!order.approvedVersionNumber || !BEFORE_PRINT_STATUSES.includes(order.status)) throw fail('Balance payments are available after magazine approval and before printing.');
}

function validateRemaining(order, payment) {
  const summary = snapshotOrderPrice(order);
  if (summary.fullyPaid) throw fail('This order is already fully paid.');
  if (payment.amount > summary.remaining) throw fail('The payment amount cannot exceed the remaining balance.', 400);
  if (sameReference(order.paymentDetails?.lipaNambaReference, payment.reference)) throw fail('This payment reference was already used for the initial payment.');
  if (order.balancePayments.some(item => item.status !== 'rejected' && sameReference(item.reference, payment.reference))) throw fail('This payment reference has already been recorded.');
  if (order.balancePayments.length >= 100) throw fail('This order has too many payment records. Contact an administrator.');
}

export function reportBalancePayment(order, input) {
  const payment = validateInput(input);
  const existing = order.balancePayments.find(item => item.status !== 'rejected' && sameReference(item.reference, payment.reference));
  if (existing) {
    if (existing.amount === payment.amount) return false;
    throw fail('This payment reference is already recorded with a different amount.');
  }
  requireBalanceStage(order);
  if (paymentSummary(order).pending) throw fail('Your previous payment is still awaiting manager approval.');
  validateRemaining(order, payment);
  order.balancePayments.push({ ...payment, status: 'pending', submittedAt: new Date() });
  order.status = 'balance_payment_review';
  return true;
}

export function reviewBalancePayment(order, input, manager) {
  const decision = input.decision;
  if (!['approve', 'reject'].includes(decision)) throw fail('Choose whether to approve or return this payment.', 400);
  let payment = input.paymentId ? order.balancePayments.id(input.paymentId) : null;
  if (input.paymentId && !payment) throw fail('Payment not found.', 404);
  if (payment && payment.status !== 'pending') {
    if (payment.status === (decision === 'approve' ? 'approved' : 'rejected')) return false;
    throw fail('This payment has already been reviewed. Refresh the order.');
  }
  requireBalanceStage(order);
  const summary = snapshotOrderPrice(order);
  if (!payment) {
    if (decision === 'reject') throw fail('Select a submitted payment to return.', 400);
    const details = validateInput(input);
    const existing = order.balancePayments.find(item => item.status === 'approved' && sameReference(item.reference, details.reference));
    if (existing) {
      if (existing.amount === details.amount) return false;
      throw fail('This payment reference is already recorded with a different amount.');
    }
    if (summary.pending) throw fail('Review the pending payment before recording another payment.');
    validateRemaining(order, details);
    order.balancePayments.push({ ...details, status: 'pending', submittedAt: new Date() });
    payment = order.balancePayments.at(-1);
  }
  if (decision === 'approve' && (summary.remaining == null || payment.amount > summary.remaining)) throw fail('The balance has changed. Refresh the order before approving this payment.');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (decision === 'reject' && (!reason || reason.length > 1000)) throw fail('Explain why the payment needs correction (up to 1,000 characters).', 400);
  payment.status = decision === 'approve' ? 'approved' : 'rejected';
  payment.reviewedAt = new Date();
  payment.reviewedBy = manager._id;
  payment.reviewedByName = manager.name;
  payment.rejectionReason = decision === 'reject' ? reason : '';
  const remaining = paymentSummary(order).remaining;
  order.status = remaining === 0 ? (order.printDocument?.uploadedAt ? 'print_manager_review' : 'client_approved') : 'awaiting_balance_payment';
  order.$locals.workflowType = decision === 'approve' ? 'balance_payment_verified' : 'balance_payment_rejected';
  return true;
}
