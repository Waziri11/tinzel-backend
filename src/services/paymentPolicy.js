export function requiredDeposit(order) {
  const total = order.totalPrice ?? order.formId?.price ?? order.price;
  if (total == null || !Number.isFinite(Number(total)) || Number(total) < 0) {
    throw Object.assign(new Error('The order price is unavailable. Review the order price before confirming payment.'), { status: 409 });
  }
  return Math.ceil(Number(total) / 2);
}

export const BALANCE_STATUSES = ['awaiting_balance_payment', 'balance_payment_review'];
export const BEFORE_PRINT_STATUSES = [...BALANCE_STATUSES, 'client_approved', 'print_document_prep', 'print_manager_review'];
const cents = value => Math.round(Number(value || 0) * 100);

export function paymentSummary(order, { client = false } = {}) {
  const rawTotal = order.totalPrice ?? order.formId?.price ?? order.price;
  const total = rawTotal != null && Number.isFinite(Number(rawTotal)) && Number(rawTotal) >= 0 ? cents(rawTotal) : null;
  const initial = order.paymentDetails;
  const history = [];
  if (initial?.verifiedAt && Number(initial.amountPaid) > 0) history.push({
    _id: 'deposit', kind: 'initial', status: 'approved', amount: Number(initial.amountPaid),
    reference: initial.lipaNambaReference || '', reviewedAt: initial.verifiedAt,
    ...(!client ? { reviewedByName: initial.verifiedByName || '' } : {}),
  });
  for (const payment of order.balancePayments || []) history.push({
    _id: String(payment._id), kind: 'balance', status: payment.status, amount: payment.amount,
    reference: payment.reference, submittedAt: payment.submittedAt, reviewedAt: payment.reviewedAt,
    rejectionReason: payment.rejectionReason || '',
    ...(!client ? { reviewedByName: payment.reviewedByName || '' } : {}),
  });
  const paid = history.filter(item => item.status === 'approved').reduce((sum, item) => sum + cents(item.amount), 0);
  const remaining = total == null ? null : Math.max(0, total - paid);
  return {
    total: total == null ? null : total / 100, paid: paid / 100,
    remaining: remaining == null ? null : remaining / 100,
    currency: order.currency || order.formId?.currency || 'TZS',
    fullyPaid: remaining === 0,
    pending: history.find(item => item.status === 'pending') || null,
    history,
  };
}

export function assertFullyPaid(order) {
  const payment = paymentSummary(order);
  if (payment.total == null) throw Object.assign(new Error('The order price is unavailable. Review the order price before confirming payment.'), { status: 409 });
  if (!payment.fullyPaid) throw Object.assign(new Error('The remaining payment must be approved by a manager before preparing or authorizing printing.'), { status: 409 });
}

export function snapshotOrderPrice(order) {
  const payment = paymentSummary(order);
  if (payment.total == null) throw Object.assign(new Error('The order price is unavailable. Review the order price before confirming payment.'), { status: 409 });
  order.totalPrice ??= payment.total;
  order.currency ||= payment.currency;
  return payment;
}
