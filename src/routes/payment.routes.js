import { Router } from 'express';
import { Order } from '../models/Order.model.js';
import { AuditLog } from '../models/AuditLog.model.js';
import { verifyClientToken } from '../middlewares/auth.middleware.js';
import { reportBalancePayment, reviewBalancePayment } from '../services/balancePaymentService.js';
import { sanitizeOrderForClient } from '../services/workflowService.js';
import { getPublicPaymentDetails } from '../services/paymentOptionsService.js';
import { kickWorkflowNotifications } from '../services/workflowNotificationService.js';

export const clientPaymentRoutes = Router();
export const managerPaymentRoutes = Router();

const failure = (res, error) => res.status(error.name === 'VersionError' ? 409 : error.status || 500).json({
  success: false,
  message: error.name === 'VersionError' ? 'This order changed in another session. Refresh before continuing.' : error.message,
});

clientPaymentRoutes.post('/balance-payment', verifyClientToken, async (req, res) => {
  try {
    const order = await Order.findById(req.clientAuth.orderId).populate('formId', 'price currency lipaNambaInstructions');
    if (!order) return res.status(404).json({ message: 'Order not found' });
    const changed = reportBalancePayment(order, req.body || {});
    if (changed) {
      await order.save();
      const payment = order.balancePayments.at(-1);
      await AuditLog.create({ actor: { type: 'client', name: order.clientName }, action: 'BALANCE_PAYMENT_SUBMITTED', orderId: order._id,
        details: { paymentId: payment._id, reference: payment.reference, amount: payment.amount } });
      await kickWorkflowNotifications(order._id);
    }
    return res.json({ success: true, order: { ...sanitizeOrderForClient(order), ...await getPublicPaymentDetails(order.formId?.lipaNambaInstructions) } });
  } catch (error) { return failure(res, error); }
});

// Mounted after the manager/admin authentication and role middleware.
managerPaymentRoutes.post('/orders/:id/balance-payment', async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).populate('formId', 'price currency');
    if (!order) return res.status(404).json({ message: 'Order not found' });
    const changed = reviewBalancePayment(order, req.body || {}, req.user);
    if (changed) {
      await order.save();
      const payment = req.body.paymentId ? order.balancePayments.id(req.body.paymentId) : order.balancePayments.at(-1);
      await AuditLog.create({ actor: { type: req.user.role, id: req.user._id, name: req.user.name },
        action: payment.status === 'approved' ? 'BALANCE_PAYMENT_VERIFIED' : 'BALANCE_PAYMENT_REJECTED', orderId: order._id,
        details: { paymentId: payment._id, amount: payment.amount, reference: payment.reference, reason: payment.rejectionReason } });
      await kickWorkflowNotifications(order._id);
    }
    return res.json({ success: true, message: req.body.decision === 'approve' ? 'Payment approved.' : 'Payment returned for correction.', order });
  } catch (error) { return failure(res, error); }
});
