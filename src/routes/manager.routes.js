import { Router } from 'express';
import { Order } from '../models/Order.model.js';
import { AuditLog } from '../models/AuditLog.model.js';
import { SystemConfig } from '../models/SystemConfig.model.js';
import { StaffUser } from '../models/StaffUser.model.js';
import { verifyStaffToken, requireRoles } from '../middlewares/auth.middleware.js';
import { generateTrackingId } from '../services/workflowService.js';
import { autoAssignOrder, manualAssignOrder, releaseOrderWorkload } from '../services/assignmentService.js';
import {
  notifyPaymentVerified,
  notifyDraftReleased,
  notifyDraftReturned,
  notifyPrinterDispatch,
  notifyPrintingInProgress,
  notifyDispatchRecorded,
  notifyOrderClosed,
} from '../services/notificationService.js';
import {
  ACTIVE_ORDER_STATUSES,
  ManagerWorkflowError,
  isConfiguredPhone,
  requireStatus,
  validateDelivery,
  validateDispatch,
  validateDraftDecision,
  validatePayment,
  validatePrinterStage,
} from '../services/managerWorkflowService.js';
import { assertExpectedVersion, closeActiveRevision, createRevisionRequest, normalizeCorrectionItems } from '../services/revisionRequestService.js';

const router = Router();

const handleManagerError = (res, error) => {
  if (error instanceof ManagerWorkflowError) {
    return res.status(error.status).json({ success: false, message: error.message });
  }
  return res.status(error.status || 500).json({ success: false, message: error.message });
};

// Manager or Admin only for all manager routes
router.use(verifyStaffToken, requireRoles('manager', 'admin'));

router.get('/designers', async (_req, res) => {
  try {
    const designers = await StaffUser.find({
      role: 'designer', isActive: true, deletedAt: null, isEligibleForAssignment: true,
    })
      .select('name currentActiveWorkload maxActiveWorkload')
      .sort({ currentActiveWorkload: 1, name: 1 })
      .lean();
    return res.json({ success: true, designers });
  } catch (error) {
    return handleManagerError(res, error);
  }
});

router.get('/settings', async (_req, res) => {
  try {
    const printerConfig = await SystemConfig.findOne({ key: 'printer_whatsapp_phone' }).lean();
    const printerPhone = typeof printerConfig?.value === 'string' ? printerConfig.value.trim() : '';
    return res.json({
      success: true,
      printer: { phone: isConfiguredPhone(printerPhone) ? printerPhone : '', configured: isConfiguredPhone(printerPhone) },
    });
  } catch (error) {
    return handleManagerError(res, error);
  }
});

const PHASE_STATUSES = {
  pre_design: ['awaiting_payment', 'payment_verified', 'queued_for_assignment'],
  design_phase: ['assigned', 'in_design', 'draft_manager_review', 'client_review', 'revision_requested'],
  post_design: [
    'client_approved',
    'print_document_prep',
    'print_manager_review',
    'printing_sent',
    'printing_in_progress',
    'printing_completed',
    'dispatched',
    'delivered',
    'closed',
  ],
};

// Get all orders across the conveyor belt stages (optionally scoped by phase)
router.get('/orders', async (req, res) => {
  try {
    const { status, search, scope = 'active', phase } = req.query;
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
    const conditions = [];

    if (status && status !== 'all') {
      conditions.push({ status });
    } else if (phase && PHASE_STATUSES[phase]) {
      const phaseList = PHASE_STATUSES[phase];
      const activePhaseList = scope === 'all' || phase === 'post_design'
        ? phaseList
        : phaseList.filter((s) => s !== 'closed');

      if (phase === 'pre_design') {
        conditions.push({
          $or: [
            { status: { $in: activePhaseList } },
            {
              status: 'on_hold',
              $or: [
                { previousStatusBeforeHold: { $in: phaseList } },
                { previousStatusBeforeHold: { $exists: false } },
                { previousStatusBeforeHold: null },
                { previousStatusBeforeHold: '' },
              ],
            },
          ],
        });
      } else {
        conditions.push({
          $or: [
            { status: { $in: activePhaseList } },
            { status: 'on_hold', previousStatusBeforeHold: { $in: phaseList } },
          ],
        });
      }
    } else if (scope !== 'all') {
      conditions.push({ status: { $in: ACTIVE_ORDER_STATUSES } });
    }

    if (search) {
      conditions.push({
        $or: [
          { clientName: { $regex: search, $options: 'i' } },
          { clientWhatsApp: { $regex: search, $options: 'i' } },
          { trackingId: { $regex: search, $options: 'i' } },
          { submissionId: { $regex: search, $options: 'i' } },
          { formTitle: { $regex: search, $options: 'i' } },
        ],
      });
    }

    const query = conditions.length === 0 ? {} : conditions.length === 1 ? conditions[0] : { $and: conditions };

    const [orderDocs, total, statusCounts] = await Promise.all([
      Order.find(query)
      .select('submissionId trackingId formId formTitle clientName clientWhatsApp clientEmail status previousStatusBeforeHold assignedDesigner currentDraftVersion revisionRequests printDocument printingDetails dispatchDetails holdReason uploadedPhotos updatedAt createdAt')
      .populate('assignedDesigner', 'name email currentActiveWorkload')
      .populate('formId', 'title slug price currency')
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
      Order.countDocuments(query),
      Order.aggregate([
        { $match: query },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ]);

    const orders = orderDocs.map((document) => {
      const order = document.toObject();
      order.photoCount = order.uploadedPhotos?.length || 0;
      delete order.uploadedPhotos;
      return order;
    });
    const counts = Object.fromEntries(statusCounts.map((entry) => [entry._id, entry.count]));
    const summary = {
      active: ACTIVE_ORDER_STATUSES.reduce((sum, item) => sum + (counts[item] || 0), 0),
      payment: counts.awaiting_payment || 0,
      paymentVerified: counts.payment_verified || 0,
      queuedAssignment: counts.queued_for_assignment || 0,
      inDesign: (counts.assigned || 0) + (counts.in_design || 0),
      draftReview: counts.draft_manager_review || 0,
      clientReview: counts.client_review || 0,
      returns: counts.revision_requested || 0,
      printPrep: (counts.client_approved || 0) + (counts.print_document_prep || 0),
      printApproval: counts.print_manager_review || 0,
      printing: (counts.printing_sent || 0) + (counts.printing_in_progress || 0),
      dispatchReady: counts.printing_completed || 0,
      delivered: (counts.dispatched || 0) + (counts.delivered || 0) + (counts.closed || 0),
      blocked: (counts.on_hold || 0) + (counts.queued_for_assignment || 0),
      onHold: counts.on_hold || 0,
    };

    return res.status(200).json({
      success: true,
      count: orders.length,
      total,
      page,
      pageCount: Math.max(1, Math.ceil(total / limit)),
      summary,
      statusCounts: counts,
      orders,
    });
  } catch (error) {
    return handleManagerError(res, error);
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
    const { reference, amount } = validatePayment(req.body);
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
      lipaNambaReference: reference,
      amountPaid: amount,
      receiptNumber: `RCP-${Date.now().toString().slice(-6)}`,
    };

    order.status = 'payment_verified';
    await order.save();

    await AuditLog.create({
      actor: { type: 'manager', id: req.user._id, name: req.user.name },
      action: 'PAYMENT_VERIFIED',
      orderId: order._id,
      details: { trackingId, lipaNambaReference: reference, amountPaid: amount },
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
    return handleManagerError(res, error);
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

    requireStatus(order, ['payment_verified', 'queued_for_assignment', 'assigned', 'in_design'], 'Designer reassignment');
    const cleanReason = typeof reason === 'string' ? reason.trim() : '';
    if (!cleanReason) throw new ManagerWorkflowError('Record a reason for reassigning this order.');
    const result = await manualAssignOrder(order, designerId, cleanReason, req.user);

    return res.status(200).json({
      success: true,
      message: 'Designer reassigned successfully',
      designer: result.designer,
      order,
    });
  } catch (error) {
    return handleManagerError(res, error);
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

    if (!['hold', 'resume'].includes(action)) throw new ManagerWorkflowError('Choose hold or resume.');
    if (action === 'hold') {
      if (order.status === 'closed') throw new ManagerWorkflowError('Closed orders cannot be placed on hold.');
      if (!reason?.trim()) throw new ManagerWorkflowError('A hold reason is required.');
      order.previousStatusBeforeHold = order.status;
      order.status = 'on_hold';
      order.holdReason = reason || 'Placed on hold by manager';
    } else {
      requireStatus(order, ['on_hold'], 'Resume');
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
    return handleManagerError(res, error);
  }
});

// Manager Review Draft: Approve/Release to Client OR Return to Designer
router.post('/orders/:id/review-draft', async (req, res) => {
  try {
    const { action, feedback, items } = validateDraftDecision(req.body);
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
    assertExpectedVersion(order, req.body.expectedVersion);

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

      closeActiveRevision(order, 'released');
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

      closeActiveRevision(order, 'returned');
      const correctionItems = normalizeCorrectionItems({ items, feedback });
      const revisionRequest = createRevisionRequest(order, {
        source: 'manager',
        actor: { type: req.user.role, id: String(req.user._id), name: req.user.name },
        items: correctionItems,
      });
      order.status = 'revision_requested';
      await order.save();

      await AuditLog.create({
        actor: { type: 'manager', id: req.user._id, name: req.user.name },
        action: 'DRAFT_RETURNED_TO_DESIGNER',
        orderId: order._id,
        details: { versionNumber: order.currentDraftVersion, feedback, requestId: revisionRequest._id, items: correctionItems },
      });

      await notifyDraftReturned(order, revisionRequest, 'manager');

      return res.status(200).json({
        success: true,
        message: 'Draft returned to designer with feedback',
        order,
      });
    }
  } catch (error) {
    return handleManagerError(res, error);
  }
});

// Authorise Printing & Dispatch to Printer via WhatsApp
router.post('/orders/:id/authorise-print', async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    requireStatus(order, ['print_manager_review'], 'Print authorization');

    if (!order.printDocument || !order.printDocument.url) {
      return res.status(400).json({
        success: false,
        message: 'Print-ready document has not been uploaded yet',
      });
    }

    // Get Printer WhatsApp Number from System Config
    const printerConfig = await SystemConfig.findOne({ key: 'printer_whatsapp_phone' });
    const printerPhone = typeof printerConfig?.value === 'string' ? printerConfig.value.trim() : '';
    if (!isConfiguredPhone(printerPhone)) {
      throw new ManagerWorkflowError('The administrator must configure a verified printer WhatsApp number before dispatch.');
    }

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
    return handleManagerError(res, error);
  }
});

// Log Printer WhatsApp Progress Update
router.post('/orders/:id/printer-update', async (req, res) => {
  try {
    const { stage, notes } = validatePrinterStage(req.body);
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (stage === 'in_progress') {
      requireStatus(order, ['printing_sent'], 'Printing acknowledgement');
      order.status = 'printing_in_progress';
      if (!order.printingDetails) order.printingDetails = {};
      order.printingDetails.acknowledgedAt = new Date();
      order.printingDetails.notes = notes || order.printingDetails.notes;
      await notifyPrintingInProgress(order);
    } else if (stage === 'completed') {
      requireStatus(order, ['printing_in_progress'], 'Printing completion');
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
    return handleManagerError(res, error);
  }
});

// Authorise Dispatch
router.post('/orders/:id/authorise-dispatch', async (req, res) => {
  try {
    const dispatch = validateDispatch(req.body);
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    requireStatus(order, ['printing_completed'], 'Dispatch authorization');
    order.dispatchDetails = {
      authorisedBy: req.user._id,
      authorisedAt: new Date(),
      ...dispatch,
    };

    order.status = 'dispatched';
    await order.save();

    await AuditLog.create({
      actor: { type: 'manager', id: req.user._id, name: req.user.name },
      action: 'ORDER_DISPATCHED',
      orderId: order._id,
      details: { carrier: dispatch.carrier, trackingReference: dispatch.trackingReference },
    });

    await notifyDispatchRecorded(order, order.dispatchDetails.trackingReference, dispatch.carrier);

    return res.status(200).json({ success: true, message: 'Order dispatched successfully', order });
  } catch (error) {
    return handleManagerError(res, error);
  }
});

// Confirm Delivery & Close Order
router.post('/orders/:id/close-order', async (req, res) => {
  try {
    const delivery = validateDelivery(req.body);
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    requireStatus(order, ['dispatched', 'delivered'], 'Delivery confirmation');
    order.deliveryDetails = {
      confirmedBy: req.user._id,
      confirmedAt: new Date(),
      ...delivery,
    };

    order.status = 'closed';
    await order.save();

    // Release designer workload
    await releaseOrderWorkload(order);

    await AuditLog.create({
      actor: { type: 'manager', id: req.user._id, name: req.user.name },
      action: 'ORDER_CLOSED_DELIVERED',
      orderId: order._id,
      details: delivery,
    });

    await notifyOrderClosed(order, delivery);

    return res.status(200).json({ success: true, message: 'Order marked delivered and closed', order });
  } catch (error) {
    return handleManagerError(res, error);
  }
});

export default router;
