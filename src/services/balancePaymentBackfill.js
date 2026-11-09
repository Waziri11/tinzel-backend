import '../models/MagazineForm.model.js';
import { Order } from '../models/Order.model.js';
import { paymentSummary, snapshotOrderPrice } from './paymentPolicy.js';
import { kickWorkflowNotifications } from './workflowNotificationService.js';

// Move legacy approved, unprinted orders into the new payment gate. Dispatched
// print jobs and completed orders retain their recorded workflow and history.
export async function backfillBalancePayments({ apply = false } = {}) {
  const statuses = ['client_approved', 'print_document_prep', 'print_manager_review'];
  const cursor = Order.find({ approvedVersionNumber: { $gt: 0 }, $or: [
    { status: { $in: statuses } }, { status: 'on_hold', previousStatusBeforeHold: { $in: statuses } },
  ] }).populate('formId', 'price currency').cursor();
  const result = { candidates: 0, updated: 0, unknownPrice: 0, conflicts: 0 };
  for await (const order of cursor) {
    const payment = paymentSummary(order);
    if (payment.total == null) { result.unknownPrice++; continue; }
    if (payment.fullyPaid) continue;
    result.candidates++;
    if (!apply) continue;
    snapshotOrderPrice(order);
    if (order.status === 'on_hold') order.previousStatusBeforeHold = 'awaiting_balance_payment';
    else order.status = 'awaiting_balance_payment';
    try { await order.save(); result.updated++; }
    catch (error) { if (error.name === 'VersionError') { result.conflicts++; continue; } throw error; }
    if (order.status !== 'on_hold') await kickWorkflowNotifications(order._id);
  }
  return result;
}
