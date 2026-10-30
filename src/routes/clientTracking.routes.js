import { assertNoPendingAnnotations, submitAnnotations } from '../services/proofReaderService.js';
import { Router } from 'express';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Order } from '../models/Order.model.js';
import { AuditLog } from '../models/AuditLog.model.js';
import { verifyClientToken, generateClientToken, getJwtSecret } from '../middlewares/auth.middleware.js';
import { createRateLimiter } from '../middlewares/rateLimiter.js';
import { sendNotification, notifyClientOtp, notifyClientApproved, notifyDraftReturned } from '../services/notificationService.js';
import { sanitizeOrderForClient } from '../services/workflowService.js';
import { streamDraftPdf } from '../services/draftFileService.js';
import { assertExpectedVersion, createRevisionRequest, normalizeCorrectionItems } from '../services/revisionRequestService.js';

const router = Router();

const MAX_OTP_ATTEMPTS = 5;

export function hashOtpCode(orderId, otpCode) {
  return createHmac('sha256', getJwtSecret())
    .update(`${String(orderId)}:${String(otpCode).trim()}`)
    .digest('hex');
}

export function verifyOtpCode(orderId, storedCode, candidateOtp) {
  const cleanCandidate = String(candidateOtp || '').trim();
  const stored = String(storedCode || '').trim();
  if (!cleanCandidate || !stored) return false;

  // Support both HMAC-SHA256 stored hashes (64 hex chars) and legacy/test 6-digit codes via timingSafeEqual
  const expected = /^[a-f0-9]{64}$/i.test(stored)
    ? stored
    : hashOtpCode(orderId, stored);
  const actual = hashOtpCode(orderId, cleanCandidate);

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

const requestOtpLimiter = createRateLimiter({
  scope: 'client-request-otp',
  maxAttempts: 5,
  windowMs: 10 * 60 * 1000,
  keyGenerator: (req) => `${req.ip || 'ip'}:${String(req.body?.trackingId || '').trim().toUpperCase()}`,
  message: 'Too many OTP requests. Please wait a few minutes before requesting another code.',
});

const verifyOtpLimiter = createRateLimiter({
  scope: 'client-verify-otp',
  maxAttempts: 10,
  windowMs: 10 * 60 * 1000,
  keyGenerator: (req) => `${req.ip || 'ip'}:${String(req.body?.trackingId || '').trim().toUpperCase()}`,
  message: 'Too many OTP verification attempts. Please wait before trying again.',
});

const UNIFORM_LOOKUP_ERROR =
  'Unable to verify tracking details. Please check your Tracking/Submission ID and registered WhatsApp number.';

export function normalizeClientPhone(rawPhone) {
  const digits = String(rawPhone || '')
    .trim()
    .replace(/[\s\-().+]/g, '');
  if (!/^\d{9,15}$/.test(digits)) {
    return null;
  }
  if (digits.length === 10 && digits.startsWith('0')) {
    return `255${digits.slice(1)}`;
  }
  if (digits.length === 9 && /^[67]/.test(digits)) {
    return `255${digits}`;
  }
  return digits;
}

async function findOrderByTrackingOrSubmissionId(rawId) {
  const cleanId = String(rawId || '').trim().toUpperCase();
  if (!cleanId) return null;
  return Order.findOne({
    $or: [{ trackingId: cleanId }, { submissionId: cleanId }],
  });
}

// Request 6-Digit OTP for Client Tracking
router.post('/request-otp', requestOtpLimiter, async (req, res) => {
  try {
    const { trackingId, clientWhatsApp } = req.body;
    if (!trackingId || !clientWhatsApp) {
      return res.status(400).json({
        success: false,
        message: 'Both Tracking ID and WhatsApp number are required',
      });
    }

    const inputPhone = normalizeClientPhone(clientWhatsApp);
    const order = await findOrderByTrackingOrSubmissionId(trackingId);
    const storedPhone = order ? normalizeClientPhone(order.clientWhatsApp) : null;

    if (!order || !inputPhone || !storedPhone || inputPhone !== storedPhone) {
      return res.status(401).json({
        success: false,
        message: UNIFORM_LOOKUP_ERROR,
      });
    }

    // Generate cryptographically random 6-digit OTP and store only its keyed HMAC-SHA256 hash
    const otpCode = randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    order.otp = {
      code: hashOtpCode(order._id, otpCode),
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
    return res.status(error.name === 'VersionError' ? 409 : error.status || 500).json({ success: false, message: error.message });
  }
});

// Verify OTP & generate client session token
router.post('/verify-otp', verifyOtpLimiter, async (req, res) => {
  try {
    const { trackingId, otp } = req.body;
    if (!trackingId || !otp) {
      return res.status(400).json({ success: false, message: 'Tracking ID and OTP code are required' });
    }

    const order = await findOrderByTrackingOrSubmissionId(trackingId);
    if (!order || !order.otp || !order.otp.code) {
      return res.status(400).json({ success: false, message: 'No active OTP request found' });
    }

    if ((order.otp.attempts || 0) >= MAX_OTP_ATTEMPTS) {
      order.otp = undefined;
      await order.save();
      return res.status(429).json({
        success: false,
        message: 'Maximum OTP attempts exceeded. Please request a new code.',
      });
    }

    if (new Date() > new Date(order.otp.expiresAt)) {
      order.otp = undefined;
      await order.save();
      return res.status(400).json({ success: false, message: 'OTP has expired. Please request a new one' });
    }

    if (!verifyOtpCode(order._id, order.otp.code, otp)) {
      const nextAttempts = (order.otp.attempts || 0) + 1;
      if (nextAttempts >= MAX_OTP_ATTEMPTS) {
        order.otp = undefined;
        await order.save();
        return res.status(429).json({
          success: false,
          message: 'Maximum OTP attempts exceeded. Please request a new code.',
        });
      }
      order.otp.attempts = nextAttempts;
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
    return res.status(error.name === 'VersionError' ? 409 : error.status || 500).json({ success: false, message: error.message });
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
    return res.status(error.name === 'VersionError' ? 409 : error.status || 500).json({ success: false, message: error.name === 'VersionError' ? 'This order changed in another session. Refresh before continuing.' : error.message });
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
  } catch (error) { return res.status(error.name === 'VersionError' ? 409 : error.status || 500).json({ success: false, message: error.message }); }
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

    assertExpectedVersion(order, req.body.expectedVersion);
    assertNoPendingAnnotations(order, 'client');
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

    await notifyClientApproved(order);

    return res.status(200).json({
      success: true,
      message: 'Whole magazine approved successfully! It has now proceeded to print document preparation.',
      order: sanitizeOrderForClient(order),
    });
  } catch (error) {
    return res.status(error.name === 'VersionError' ? 409 : error.status || 500).json({ success: false, message: error.name === 'VersionError' ? 'This order changed in another session. Refresh before continuing.' : error.message });
  }
});

// Request Revisions (Restarts approval loop)
router.post('/request-revision', verifyClientToken, async (req, res) => {
  try {

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

    const items = normalizeCorrectionItems({ ...req.body, items: submitAnnotations(order, 'client', (Array.isArray(req.body.items) ? req.body.items : []).filter((i) => String(i?.text || '').trim()).map((i) => ({ text: i.text, pageReference: i.pageReference }))) });

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

    await notifyDraftReturned(order, revisionRequest, 'client');

    return res.status(200).json({
      success: true,
      message: 'Revision request submitted. Your designer will review the feedback and update the draft.',
      order: sanitizeOrderForClient(order),
    });
  } catch (error) {
    return res.status(error.name === 'VersionError' ? 409 : error.status || 500).json({ success: false, message: error.message });
  }
});

export default router;
