import { Router } from 'express';
import { Order } from '../models/Order.model.js';
import { AuditLog } from '../models/AuditLog.model.js';
import { SystemConfig } from '../models/SystemConfig.model.js';
import { verifyStaffToken, requireRoles } from '../middlewares/auth.middleware.js';
import { generateTrackingId } from '../services/workflowService.js';
import { autoAssignOrder, manualAssignOrder, releaseOrderWorkload } from '../services/assignmentService.js';
import {
  notifyPaymentVerified,
  notifyDraftReleased,
  notifyPrinterDispatch,
  notifyPrintingInProgress,
  notifyDispatchRecorded,
} from '../services/notificationService.js';

const router = Router();

// Manager or Admin only for all manager routes
router.use(verifyStaffToken, requireRoles('manager', 'admin'));

// Get all orders across the conveyor belt stages
router.get('/orders', async (req, res) => {
  try {
    const { status, search } = req.query;
    const query = {};

    if (status && status !== 'all') {
      query.status = status;
    }

    if (search) {
      query.$or = [
        { clientName: { $regex: search, $options: 'i' } },
        { clientWhatsApp: { $regex: search, $options: 'i' } },
        { trackingId: { $regex: search, $options: 'i' } },
        { submissionId: { $regex: search, $options: 'i' } },
      ];
    }

    const orders = await Order.find(query)
      .populate('assignedDesigner', 'name email currentActiveWorkload')
      .populate('formId', 'title slug price currency')
      .sort({ updatedAt: -1 });

    return res.status(200).json({ success: true, count: orders.length, orders });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Get single order detail
router.get('/orders/:id', async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('assignedDesigner', 'name email phone currentActiveWorkload maxActiveWorkload')
      .populate('formId');

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const auditLogs = await AuditLog.find({ orderId: order._id }).sort({ createdAt: -1 });

    return res.status(200).json({ success: true, order, auditLogs });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Verify Payment & Issue Tracking ID -> Trigger Auto-Assignment
router.post('/orders/:id/verify-payment', async (req, res) => {
  try {
    const { lipaNambaReference, amountPaid } = req.body;
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.status !== 'awaiting_payment') {
      return res.status(400).json({
        success: false,
        message: `Order status is '${order.status}'. Payment can only be verified when 'awaiting_payment'.`,
      });
    }

    // Generate tracking ID ONLY NOW (strict PRD rule)
    const trackingId = await generateTrackingId();
    order.trackingId = trackingId;
    order.paymentDetails = {
      verifiedBy: req.user._id,
      verifiedAt: new Date(),
      lipaNambaReference: lipaNambaReference || 'VERIFIED-BY-MANAGER',
      amountPaid: Number(amountPaid) || 0,
      receiptNumber: `RCP-${Date.now().toString().slice(-6)}`,
    };

    order.status = 'payment_verified';
    await order.save();

    await AuditLog.create({
      actor: { type: 'manager', id: req.user._id, name: req.user.name },
      action: 'PAYMENT_VERIFIED',
      orderId: order._id,
      details: { trackingId, lipaNambaReference, amountPaid },
    });

    // Send payment verification notification to client
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const trackingUrl = `${frontendUrl}/track`;
    await notifyPaymentVerified(order, trackingUrl);

    // Trigger auto-assignment to eligible designer with lowest workload
    const assignResult = await autoAssignOrder(order, req.user);

    return res.status(200).json({
      success: true,
      message: 'Payment verified and tracking ID issued.',
      trackingId,
      assignment: assignResult,
      order,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Manual Reassign Designer
router.post('/orders/:id/reassign', async (req, res) => {
  try {
    const { designerId, reason } = req.body;
    if (!designerId) {
      return res.status(400).json({ success: false, message: 'Target designer ID is required' });
    }

    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const result = await manualAssignOrder(order, designerId, reason, req.user);

    return res.status(200).json({
      success: true,
      message: 'Designer reassigned successfully',
      designer: result.designer,
      order,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Put Order On Hold / Release Hold
router.post('/orders/:id/hold', async (req, res) => {
  try {
    const { action, reason } = req.body; // action: 'hold' | 'resume'
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (action === 'hold') {
      order.previousStatusBeforeHold = order.status;
      order.status = 'on_hold';
      order.holdReason = reason || 'Placed on hold by manager';
    } else {
      order.status = order.previousStatusBeforeHold || 'in_design';
      order.holdReason = '';
    }

    await order.save();

    await AuditLog.create({
      actor: { type: 'manager', id: req.user._id, name: req.user.name },
      action: action === 'hold' ? 'ORDER_HELD' : 'ORDER_HOLD_RELEASED',
      orderId: order._id,
      details: { reason },
    });

    return res.status(200).json({ success: true, message: `Order ${action} executed`, order });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Manager Review Draft: Approve/Release to Client OR Return to Designer
router.post('/orders/:id/review-draft', async (req, res) => {
  try {
    const { action, feedback } = req.body; // action: 'release_to_client' | 'return_to_designer'
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.status !== 'draft_manager_review') {
      return res.status(400).json({
        success: false,
        message: `Order must be in 'draft_manager_review' status. Current: ${order.status}`,
      });
    }

    const currentDraft = order.draftVersions.find((v) => v.versionNumber === order.currentDraftVersion);
    if (!currentDraft) {
      return res.status(400).json({ success: false, message: 'No current draft version found' });
    }

    if (action === 'release_to_client') {
      currentDraft.managerReview = {
        status: 'approved',
        reviewedBy: req.user._id,
        reviewedAt: new Date(),
        feedback: feedback || 'Manager approved draft for client whole-magazine review.',
      };

      order.status = 'client_review';
      await order.save();

      await AuditLog.create({
        actor: { type: 'manager', id: req.user._id, name: req.user.name },
        action: 'DRAFT_RELEASED_TO_CLIENT',
        orderId: order._id,
        details: { versionNumber: order.currentDraftVersion },
      });

      // Send WhatsApp notification to Client that draft is released
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      await notifyDraftReleased(order, `${frontendUrl}/track`);

      return res.status(200).json({
        success: true,
        message: 'Draft approved and released to client for review',
        order,
      });
    } else {
      // Return to designer
      currentDraft.managerReview = {
        status: 'returned',
        reviewedBy: req.user._id,
        reviewedAt: new Date(),
        feedback: feedback || 'Changes required before client release.',
      };

      order.status = 'in_design';
      await order.save();

      await AuditLog.create({
        actor: { type: 'manager', id: req.user._id, name: req.user.name },
        action: 'DRAFT_RETURNED_TO_DESIGNER',
        orderId: order._id,
        details: { versionNumber: order.currentDraftVersion, feedback },
      });

      return res.status(200).json({
        success: true,
        message: 'Draft returned to designer with feedback',
        order,
      });
    }
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Authorise Printing & Dispatch to Printer via WhatsApp
router.post('/orders/:id/authorise-print', async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.status !== 'print_manager_review' && order.status !== 'client_approved') {
      return res.status(400).json({
        success: false,
        message: `Order must have client whole-magazine approval and print document ready. Current status: ${order.status}`,
      });
    }

    if (!order.printDocument || !order.printDocument.url) {
      return res.status(400).json({
        success: false,
        message: 'Print-ready document has not been uploaded yet',
      });
    }

    // Get Printer WhatsApp Number from System Config
    const printerConfig = await SystemConfig.findOne({ key: 'printer_whatsapp_phone' });
    const printerPhone = req.body.printerPhone || (printerConfig ? printerConfig.value : '+255712345678');

    order.printDocument.managerAuthorisedBy = req.user._id;
    order.printDocument.managerAuthorisedAt = new Date();

    order.printingDetails = {
      sentAt: new Date(),
      printerPhone,
      notes: req.body.notes || 'Dispatched by Manager',
    };

    order.status = 'printing_sent';
    await order.save();

    await AuditLog.create({
      actor: { type: 'manager', id: req.user._id, name: req.user.name },
      action: 'PRINT_AUTHORISED_AND_DISPATCHED',
      orderId: order._id,
      details: { printerPhone, printDocUrl: order.printDocument.url },
    });

    // Dispatch WhatsApp notification to printing partner
    const fullPrintUrl = `${req.protocol}://${req.get('host')}${order.printDocument.url}`;
    await notifyPrinterDispatch(order, printerPhone, fullPrintUrl, order.printDocument.specs || {});

    return res.status(200).json({
      success: true,
      message: 'Print document authorised and dispatched to Printer via WhatsApp',
      order,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Log Printer WhatsApp Progress Update
router.post('/orders/:id/printer-update', async (req, res) => {
  try {
    const { stage, notes } = req.body; // stage: 'in_progress' | 'completed'
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (stage === 'in_progress') {
      order.status = 'printing_in_progress';
      if (!order.printingDetails) order.printingDetails = {};
      order.printingDetails.acknowledgedAt = new Date();
      order.printingDetails.notes = notes || order.printingDetails.notes;
      await notifyPrintingInProgress(order);
    } else if (stage === 'completed') {
      order.status = 'printing_completed';
      if (!order.printingDetails) order.printingDetails = {};
      order.printingDetails.completedAt = new Date();
      order.printingDetails.managerVerifiedAt = new Date();
      order.printingDetails.notes = notes || order.printingDetails.notes;
    }

    await order.save();

    await AuditLog.create({
      actor: { type: 'manager', id: req.user._id, name: req.user.name },
      action: `PRINTER_STATUS_${stage.toUpperCase()}`,
      orderId: order._id,
      details: { stage, notes },
    });

    return res.status(200).json({ success: true, message: `Printing stage updated to ${stage}`, order });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Authorise Dispatch
router.post('/orders/:id/authorise-dispatch', async (req, res) => {
  try {
    const { carrier, trackingReference, deliveryAddress, notes } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    order.dispatchDetails = {
      authorisedBy: req.user._id,
      authorisedAt: new Date(),
      carrier: carrier || 'Standard Courier',
      trackingReference: trackingReference || `PKG-${Date.now().toString().slice(-6)}`,
      deliveryAddress: deliveryAddress || '',
      notes: notes || '',
    };

    order.status = 'dispatched';
    await order.save();

    await AuditLog.create({
      actor: { type: 'manager', id: req.user._id, name: req.user.name },
      action: 'ORDER_DISPATCHED',
      orderId: order._id,
      details: { carrier, trackingReference },
    });

    await notifyDispatchRecorded(order, order.dispatchDetails.trackingReference, carrier);

    return res.status(200).json({ success: true, message: 'Order dispatched successfully', order });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Confirm Delivery & Close Order
router.post('/orders/:id/close-order', async (req, res) => {
  try {
    const { recipientFeedback } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    order.deliveryDetails = {
      confirmedBy: req.user._id,
      confirmedAt: new Date(),
      recipientFeedback: recipientFeedback || 'Delivered to client in good condition.',
    };

    order.status = 'closed';
    await order.save();

    // Release designer workload
    await releaseOrderWorkload(order);

    await AuditLog.create({
      actor: { type: 'manager', id: req.user._id, name: req.user.name },
      action: 'ORDER_CLOSED_DELIVERED',
      orderId: order._id,
      details: { recipientFeedback },
    });

    return res.status(200).json({ success: true, message: 'Order marked delivered and closed', order });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
