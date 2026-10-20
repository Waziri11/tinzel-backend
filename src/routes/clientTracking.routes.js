import { Router } from 'express';
import { Order } from '../models/Order.model.js';
import { AuditLog } from '../models/AuditLog.model.js';
import { verifyClientToken, generateClientToken } from '../middlewares/auth.middleware.js';
import { sendNotification, notifyClientOtp } from '../services/notificationService.js';
import { sanitizeOrderForClient } from '../services/workflowService.js';
import { streamDraftPdf } from '../services/draftFileService.js';
import { assertExpectedVersion, createRevisionRequest, normalizeCorrectionItems } from '../services/revisionRequestService.js';

const router = Router();

// Request 6-Digit OTP for Client Tracking
router.post('/request-otp', async (req, res) => {
  try {
    const { trackingId, clientWhatsApp } = req.body;
    if (!trackingId || !clientWhatsApp) {
      return res.status(400).json({
        success: false,
        message: 'Both Tracking ID and WhatsApp number are required',
      });
    }

    const cleanPhone = clientWhatsApp.trim().replace(/\s+/g, '');
    const cleanTrackingId = trackingId.trim().toUpperCase();

    const order = await Order.findOne({
      trackingId: cleanTrackingId,
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'No order found with the provided Tracking ID',
      });
    }

    // Verify phone match (allow with or without country code prefix match)
    const storedPhone = order.clientWhatsApp.replace(/\s+/g, '').replace('+', '');
    const inputPhone = cleanPhone.replace('+', '');

    if (!storedPhone.endsWith(inputPhone) && !inputPhone.endsWith(storedPhone)) {
      return res.status(401).json({
        success: false,
        message: 'The WhatsApp number does not match this Tracking ID record',
      });
    }

    // Generate 6-digit OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    order.otp = {
      code: otpCode,
      expiresAt,
      attempts: 0,
    };
    await order.save();

    // Send OTP via multi-channel notification service (WhatsApp & Email if available)
    await notifyClientOtp(order, otpCode);

    return res.status(200).json({
      success: true,
      message: 'OTP sent to your registered contact channel',
      // For local development convenience, provide otp in dev mode
      devOtp: process.env.NODE_ENV !== 'production' ? otpCode : undefined,
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

// Verify OTP & generate client session token
router.post('/verify-otp', async (req, res) => {
  try {
    const { trackingId, otp } = req.body;
    if (!trackingId || !otp) {
      return res.status(400).json({ success: false, message: 'Tracking ID and OTP code are required' });
    }

    const order = await Order.findOne({ trackingId: trackingId.trim().toUpperCase() });
    if (!order || !order.otp || !order.otp.code) {
      return res.status(400).json({ success: false, message: 'No active OTP request found' });
    }

    if (new Date() > new Date(order.otp.expiresAt)) {
      return res.status(400).json({ success: false, message: 'OTP has expired. Please request a new one' });
    }

    if (order.otp.code !== otp.trim()) {
      order.otp.attempts = (order.otp.attempts || 0) + 1;
      await order.save();
      return res.status(400).json({ success: false, message: 'Invalid OTP code' });
    }

    // Clear OTP after successful verification
    order.otp = undefined;
    await order.save();

    const clientToken = generateClientToken(order);

    return res.status(200).json({
      success: true,
      clientToken,
      message: 'Access granted',
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

// Get sanitized order details for client portal
router.get('/order', verifyClientToken, async (req, res) => {
  try {
    const order = await Order.findById(req.clientAuth.orderId)
      .populate('formId', 'title description price currency')
      .populate('assignedDesigner', 'name');

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const sanitized = sanitizeOrderForClient(order);
    return res.status(200).json({ success: true, order: sanitized });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/draft/view', verifyClientToken, async (req, res) => {
  try {
    const order = await Order.findById(req.clientAuth.orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    const allowed = ['client_review', 'revision_requested', 'client_approved', 'print_document_prep', 'print_manager_review', 'printing_sent', 'printing_in_progress', 'printing_completed', 'dispatched', 'delivered', 'closed'];
    const draft = order.draftVersions.find((item) => item.versionNumber === order.currentDraftVersion);
    if (!allowed.includes(order.status) || !draft || draft.managerReview?.status !== 'approved') {
      return res.status(404).json({ success: false, message: 'No magazine proof is currently available' });
    }
    return streamDraftPdf(res, draft);
  } catch (error) { return res.status(error.status || 500).json({ success: false, message: error.message }); }
});

// Whole-Magazine Client Approval
router.post('/approve-draft', verifyClientToken, async (req, res) => {
  try {
    const order = await Order.findById(req.clientAuth.orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.status !== 'client_review') {
      return res.status(400).json({
        success: false,
        message: `Cannot approve magazine in current status: ${order.status}. Must be in 'client_review'.`,
      });
    }

    const currentVersion = order.draftVersions.find(
      (v) => v.versionNumber === order.currentDraftVersion
    );

    if (!currentVersion || !currentVersion.managerReview || currentVersion.managerReview.status !== 'approved') {
      return res.status(400).json({
        success: false,
        message: 'No released draft version is currently awaiting your approval',
      });
    }

    // Record Client Whole-Magazine Approval
    currentVersion.clientReview = {
      status: 'approved',
      reviewedAt: new Date(),
      feedback: req.body.feedback || 'Whole magazine approved by client without revisions.',
    };

    order.approvedVersionNumber = order.currentDraftVersion;
    order.status = 'client_approved';
    await order.save();

    await AuditLog.create({
      actor: { type: 'client', name: order.clientName },
      action: 'CLIENT_WHOLE_MAGAZINE_APPROVED',
      orderId: order._id,
      details: {
        versionNumber: order.currentDraftVersion,
        feedback: req.body.feedback,
      },
    });

    return res.status(200).json({
      success: true,
      message: 'Whole magazine approved successfully! It has now proceeded to print document preparation.',
      order: sanitizeOrderForClient(order),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Request Revisions (Restarts approval loop)
router.post('/request-revision', verifyClientToken, async (req, res) => {
  try {
    const items = normalizeCorrectionItems(req.body);

    const order = await Order.findById(req.clientAuth.orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.status !== 'client_review') {
      return res.status(400).json({
        success: false,
        message: 'Order is not currently in client review stage',
      });
    }
    assertExpectedVersion(order, req.body.expectedVersion);

    const currentVersion = order.draftVersions.find(
      (v) => v.versionNumber === order.currentDraftVersion
    );

    if (currentVersion) {
      currentVersion.clientReview = {
        status: 'revision_requested',
        reviewedAt: new Date(),
        feedback: items.map((item) => item.text).join('\n'),
      };
    }

    const revisionRequest = createRevisionRequest(order, {
      source: 'client',
      actor: { type: 'client', name: order.clientName },
      items,
    });

    // Restart approval loop back to in_design
    order.status = 'revision_requested';
    await order.save();

    await AuditLog.create({
      actor: { type: 'client', name: order.clientName },
      action: 'CLIENT_REVISION_REQUESTED',
      orderId: order._id,
      details: {
        versionNumber: order.currentDraftVersion,
        feedback: items.map((item) => item.text).join('\n'),
        requestId: revisionRequest._id,
        items,
      },
    });

    return res.status(200).json({
      success: true,
      message: 'Revision request submitted. Your designer will review the feedback and update the draft.',
      order: sanitizeOrderForClient(order),
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

export default router;
