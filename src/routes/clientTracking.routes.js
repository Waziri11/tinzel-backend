import { parseRevisionUpload, saveRevisionAudio, deleteRevisionAudio, streamRevisionAudio } from '../services/revisionAudioService.js';
import { formatTanzanianPhone } from '../services/smsService.js';
import { normalizePhone } from '../utils/phone.js';
import {setSessionCookie,cookieValue,digest} from '../services/accessSessionService.js';
import {AccessSession} from '../models/AccessSession.model.js';
import { kickWorkflowNotifications } from '../services/workflowNotificationService.js';
import { assertNoPendingAnnotations, submitAnnotations } from '../services/proofReaderService.js';
import { Router } from 'express';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Notification } from '../models/Notification.model.js';
import mongoose from 'mongoose';
import { Order } from '../models/Order.model.js';
import { AuditLog } from '../models/AuditLog.model.js';
import { verifyClientToken, generateClientToken, getJwtSecret } from '../middlewares/auth.middleware.js';
import { createRateLimiter } from '../middlewares/rateLimiter.js';
import { notifyClientOtp } from '../services/notificationService.js';
import { sanitizeOrderForClient } from '../services/workflowService.js';
import { streamDraftPdf } from '../services/draftFileService.js';
import { assertExpectedVersion, createRevisionRequest, normalizeCorrectionItems } from '../services/revisionRequestService.js';

const router = Router();

router.patch('/preferences',verifyClientToken,async(req,res)=>{
  if(!['en','sw'].includes(req.body.preferredLanguage)) return res.status(400).json({message:'Choose English or Kiswahili'});
  const result=await Order.updateOne({_id:req.clientAuth.orderId},{$set:{clientPreferredLanguage:req.body.preferredLanguage}});
  if(!result.matchedCount)return res.sendStatus(404);
  res.json({success:true,preferredLanguage:req.body.preferredLanguage});
});
router.get('/notifications',verifyClientToken,async(req,res)=>{
  const filter={orderId:req.clientAuth.orderId,recipientRole:'client',channel:'in_system'};
  const [notifications,unreadCount]=await Promise.all([
    Notification.find(filter).sort({createdAt:-1}).limit(50).select('_id title message isRead createdAt').lean(),
    Notification.countDocuments({...filter,isRead:false}),
  ]);
  res.json({success:true,notifications,unreadCount});
});
router.patch('/notifications/:id/read',verifyClientToken,async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id))return res.sendStatus(404);
  const result=await Notification.updateOne({_id:req.params.id,orderId:req.clientAuth.orderId,recipientRole:'client',channel:'in_system'},{$set:{isRead:true,readAt:new Date()}});
  if(!result.matchedCount)return res.sendStatus(404);
  res.json({success:true});
});

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
  keyGenerator: (req) => `${req.ip || 'ip'}:${trackingLookupKey(req.body?.trackingId)}`,
  message: 'Too many OTP requests. Please wait a few minutes before requesting another code.',
});

const verifyOtpLimiter = createRateLimiter({
  scope: 'client-verify-otp',
  maxAttempts: 10,
  windowMs: 10 * 60 * 1000,
  keyGenerator: (req) => `${req.ip || 'ip'}:${trackingLookupKey(req.body?.trackingId)}`,
  message: 'Too many OTP verification attempts. Please wait before trying again.',
});

const UNIFORM_LOOKUP_ERROR =
  'Unable to verify tracking details. Please check your Tracking/Submission ID and registered phone number.';

// Preserve the existing digits-only binding for remembered devices and OTPs.
export const normalizeClientPhone = raw => normalizePhone(raw)?.slice(1) || null;

export function trackingLookupKey(rawId) {
  const id = typeof rawId === 'string' ? rawId.trim().toUpperCase() : '';
  const match = /^TNZ-(\d{4})-(\d{1,20})$/.exec(id);
  return match ? `TNZ-${match[1]}-${match[2].replace(/^0+(?=\d)/, '')}` : id.slice(0, 100);
}

export async function findOrderByTrackingOrSubmissionId(rawId) {
  const cleanId = typeof rawId === 'string' ? rawId.trim().toUpperCase() : '';
  if (!cleanId || cleanId.length > 100) return null;
  const exact = await Order.findOne({ $or: [{ trackingId: cleanId }, { submissionId: cleanId }] });
  if (exact) return exact;
  const match = /^TNZ-(\d{4})-(\d{1,20})$/.exec(cleanId);
  if (!match) return null;
  const sequence = match[2].replace(/^0+(?=\d)/, '');
  const candidates = await Order.find({ trackingId: new RegExp(`^TNZ-${match[1]}-0*${sequence}$`) }).limit(2);
  return candidates.length === 1 ? candidates[0] : null;
}

const DEVICE_TRUST_MS = 30 * 24 * 60 * 60 * 1000;
const deviceCookie = orderId => `tracking_${orderId}`;
const trackingBinding = order => digest(JSON.stringify([String(order._id), normalizeClientPhone(order.clientWhatsApp), order.clientAccessVersion || 0]));

async function trustsSubmission(req, order) {
  const token = cookieValue(req, deviceCookie(order._id));
  if (!/^[a-f0-9]{64}$/.test(token || '')) return false;
  return AccessSession.exists({
    _id: digest(token), kind: 'tracking_device', subjectId: String(order._id),
    contactFingerprint: trackingBinding(order), expiresAt: { $gt: new Date() },
  });
}

async function startTrackingSession(res, order, remember = false) {
  const token = await generateClientToken(order);
  const session = await AccessSession.findById(digest(token));
  if (remember) {
    const deviceToken = randomBytes(32).toString('hex');
    await AccessSession.create({
      _id: digest(deviceToken), kind: 'tracking_device', subjectId: String(order._id),
      contactFingerprint: trackingBinding(order), expiresAt: new Date(Date.now() + DEVICE_TRUST_MS),
    });
    setSessionCookie(res, deviceCookie(order._id), deviceToken, DEVICE_TRUST_MS);
  }
  setSessionCookie(res, 'client', token, 8 * 3600000);
  return res.json({ success: true, clientToken: 'cookie', csrf: session.csrf });
}

// Request 6-Digit OTP for Client Tracking
router.post('/request-otp', requestOtpLimiter, async (req, res) => {
  try {
    const { trackingId, clientWhatsApp } = req.body;
    // A passive return visit may restore an existing grant, but never sends SMS.
    if (req.body.resumeOnly === true) {
      const order = await findOrderByTrackingOrSubmissionId(trackingId);
      if (!order || !await trustsSubmission(req, order)) return res.json({ success: false });
      return await startTrackingSession(res, order);
    }
    if (!trackingId || !clientWhatsApp) {
      return res.status(400).json({
        success: false,
        message: 'Both Tracking ID and phone number are required',
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

    if (await trustsSubmission(req, order)) return await startTrackingSession(res, order);

    formatTanzanianPhone(clientWhatsApp);

    // Generate cryptographically random 6-digit OTP and store only its keyed HMAC-SHA256 hash
    const otpCode = randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    const sms = await notifyClientOtp(order, otpCode);
    const accepted = ['sent', 'delivered'].includes(sms.status)
      || (process.env.NODE_ENV !== 'production' && sms.status === 'simulated');
    if (!accepted) return res.status(502).json({ success: false, message: 'Unable to send the SMS code. Please try again.' });

    order.otp = { code: hashOtpCode(order._id, otpCode), binding: trackingBinding(order), expiresAt, attempts: 0 };
    await order.save();
    return res.status(200).json({
      success: true,
      channel: 'sms',
      message: 'Code sent by SMS',
      // For local development convenience, provide otp in dev mode
      devOtp: process.env.NODE_ENV !== 'production' && sms.status === 'simulated' ? otpCode : undefined,
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
    if (!order || !order.otp || !order.otp.code || order.otp.binding !== trackingBinding(order)) {
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

    return await startTrackingSession(res, order, true);
  } catch (error) {
    return res.status(error.name === 'VersionError' ? 409 : error.status || 500).json({ success: false, message: error.message });
  }
});

router.post('/logout', verifyClientToken, async (req, res) => {
  if (req.body?.forgetDevice === true) {
    const name = deviceCookie(req.clientAuth.orderId);
    const token = cookieValue(req, name);
    if (token) await AccessSession.deleteOne({ _id: digest(token), kind: 'tracking_device', subjectId: String(req.clientAuth.orderId) });
    setSessionCookie(res, name, '', 0);
  }
  await AccessSession.deleteOne({ _id: req.accessSession._id });
  setSessionCookie(res, 'client', '', 0);
  res.json({ success: true });
});

// Get sanitized order details for client portal
router.get('/order', verifyClientToken, async (req, res) => {
  try {
    const order = await Order.findById(req.clientAuth.orderId)
      .populate('formId', 'title description price currency lipaNambaInstructions')
      .populate('assignedDesigner', 'name');

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const sanitized = sanitizeOrderForClient(order);
    return res.status(200).json({ success: true, csrf:req.accessSession.csrf, order: sanitized });
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

    await kickWorkflowNotifications(order._id);

    return res.status(200).json({
      success: true,
      message: 'Whole magazine approved successfully! It has now proceeded to print document preparation.',
      order: sanitizeOrderForClient(order),
    });
  } catch (error) {
    return res.status(error.name === 'VersionError' ? 409 : error.status || 500).json({ success: false, message: error.name === 'VersionError' ? 'This order changed in another session. Refresh before continuing.' : error.message });
  }
});

router.get('/revisions/:requestId/items/:itemId/audio', verifyClientToken, async (req, res, next) => {
  try { await streamRevisionAudio(req, res, await Order.findById(req.clientAuth.orderId), true); } catch (error) { next(error); }
});

// Request Revisions (Restarts approval loop)
router.post('/request-revision', verifyClientToken, parseRevisionUpload, async (req, res) => {
  let audio;
  let saved = false;
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

    const supplied = (req.body.items || []).filter(i => String(i?.text || '').trim()).map(i => ({ text: i.text, pageReference: i.pageReference }));
    if (!supplied.length && req.body.feedback) supplied.push({ text: req.body.feedback });
    const submitted = submitAnnotations(order, 'client', supplied);
    // Audio is a required checklist item, so it must be addressed before a corrected draft is submitted.
    if (req.file) submitted.push({ text: 'Audio feedback', pageReference: '' });
    const items = normalizeCorrectionItems({ items: submitted });
    if (req.file) {
      audio = await saveRevisionAudio(req.file, order._id);
      items[items.length - 1].audio = audio;
    }

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
    saved = true;

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

    await kickWorkflowNotifications(order._id);

    return res.status(200).json({
      success: true,
      message: 'Revision request submitted. Your designer will review the feedback and update the draft.',
      order: sanitizeOrderForClient(order),
    });
  } catch (error) {
    if (audio && !saved) await deleteRevisionAudio(audio).catch(() => {});
    return res.status(error.name === 'VersionError' ? 409 : error.status || 500).json({ success: false, message: error.message });
  }
});

export default router;
