import { Router } from 'express';
import { verifyStaffToken, requireRoles } from '../middlewares/auth.middleware.js';
import { verifyTwilioWebhook } from '../middlewares/twilioWebhook.middleware.js';
import { Order } from '../models/Order.model.js';
import { AuditLog } from '../models/AuditLog.model.js';
import { SystemConfig } from '../models/SystemConfig.model.js';
import {
  normalizePhoneNumber,
  updateNotificationDeliveryStatus,
  recordInboundNotification,
  getNotificationHistory,
  markNotificationRead,
  markAllNotificationsRead,
  resendNotification,
  sendNotification,
  dispatchTriChannelNotification,
  testTwilioConnection,
  notifyPrintingInProgress,
  isTwilioConfigured,
} from '../services/notificationService.js';

const router = Router();

// ==========================================
// 1. PUBLIC TWILIO WEBHOOKS
// ==========================================

/**
 * Twilio Status Callback Webhook
 * Twilio POSTs delivery state changes: queued, sent, delivered, undelivered, failed.
 */
router.post('/webhooks/twilio-status', verifyTwilioWebhook, async (req, res) => {
  try {
    const {
      MessageSid,
      SmsSid,
      MessageStatus,
      SmsStatus,
      ErrorCode,
      ErrorMessage,
    } = req.body;

    const sid = MessageSid || SmsSid;
    const status = MessageStatus || SmsStatus;

    if (!sid || !status) {
      return res.status(400).json({ success: false, message: 'Missing MessageSid or MessageStatus' });
    }

    const updated = await updateNotificationDeliveryStatus({
      twilioSid: sid,
      status: status.toLowerCase(),
      errorCode: ErrorCode || null,
      errorMessage: ErrorMessage || null,
    });

    console.log(`[Twilio Webhook - Status Callback] SID: ${sid} | Status: ${status}`);

    // If delivery failed or undelivered and linked to an order, log an audit trail
    if (['failed', 'undelivered'].includes(status.toLowerCase()) && updated?.orderId) {
      try {
        await AuditLog.create({
          actor: { type: 'system', name: 'Twilio Status Webhook' },
          action: 'NOTIFICATION_DELIVERY_FAILED',
          orderId: updated.orderId,
          details: {
            twilioSid: sid,
            status,
            errorCode: ErrorCode,
            errorMessage: ErrorMessage,
            recipient: updated.recipient,
            channel: updated.channel,
          },
        });
      } catch {
        // Continue cleanly
      }
    }

    res.type('text/xml').send('<Response/>');
  } catch (error) {
    console.error(`[Twilio Webhook - Status Callback Error] ${error.message}`);
    res.status(500).type('text/xml').send('<Response/>');
  }
});

/**
 * Twilio Inbound Message Webhook
 * Handles inbound SMS & WhatsApp messages, including printer "POKEA" automation.
 */
router.post('/webhooks/twilio-inbound', verifyTwilioWebhook, async (req, res) => {
  try {
    const rawFrom = req.body.From || '';
    const rawTo = req.body.To || '';
    const body = (req.body.Body || '').trim();
    const messageSid = req.body.MessageSid || req.body.SmsSid || '';

    const isWhatsApp = rawFrom.startsWith('whatsapp:') || rawTo.startsWith('whatsapp:');
    const channel = isWhatsApp ? 'whatsapp' : 'sms';

    // Normalize phone numbers
    const cleanFromPhone = rawFrom.replace(/^whatsapp:/i, '').trim();
    const normalizedSender = normalizePhoneNumber(cleanFromPhone);

    console.log(`[Twilio Inbound Message] From: ${normalizedSender} (${channel}) | Body: "${body}"`);

    // Check if sender matches configured printer phone
    const printerConfig = await SystemConfig.findOne({ key: 'printer_whatsapp_phone' }).lean();
    const rawPrinterPhone = typeof printerConfig?.value === 'string' ? printerConfig.value.trim() : '';
    const normalizedPrinterPhone = normalizePhoneNumber(rawPrinterPhone);

    const isPrinterSender = Boolean(
      normalizedPrinterPhone &&
      normalizedSender &&
      normalizedPrinterPhone === normalizedSender
    );

    // Automation: Printer confirms order receipt with 'POKEA'
    if (isPrinterSender && /pokea|poke|received|confirm/i.test(body)) {
      // Find the most recent order in 'printing_sent' status
      const targetOrder = await Order.findOne({ status: 'printing_sent' })
        .sort({ updatedAt: -1 });

      if (targetOrder) {
        targetOrder.status = 'printing_in_progress';
        await targetOrder.save();

        await AuditLog.create({
          actor: { type: 'system', name: 'Twilio Printer Inbound' },
          action: 'PRINTER_CONFIRMED_POKEA',
          orderId: targetOrder._id,
          details: {
            printerPhone: normalizedSender,
            messageSid,
            body,
            orderTrackingId: targetOrder.trackingId,
          },
        });

        // Record inbound message in notifications
        await recordInboundNotification({
          from: normalizedSender,
          to: rawTo.replace(/^whatsapp:/i, ''),
          body,
          twilioSid: messageSid,
          channel,
          orderId: targetOrder._id,
          metadata: { intent: 'printer_pokea', orderTrackingId: targetOrder.trackingId },
        });

        // Trigger milestone notification to client: printing is now officially in progress
        await notifyPrintingInProgress(targetOrder);

        const replyMessage = `Tinzel: Asante! Oda ya ${targetOrder.formTitle || targetOrder.trackingId} imethibitishwa kuwa inachapwa sasa.`;
        return res.type('text/xml').send(`<Response><Message>${replyMessage}</Message></Response>`);
      }

      // No pending printing order found
      await recordInboundNotification({
        from: normalizedSender,
        to: rawTo.replace(/^whatsapp:/i, ''),
        body,
        twilioSid: messageSid,
        channel,
        metadata: { intent: 'printer_pokea_no_pending_order' },
      });

      const replyMessage = `Tinzel: Ujumbe wako umepokelewa. Kwa sasa hakuna oda inayosubiri kuchapwa.`;
      return res.type('text/xml').send(`<Response><Message>${replyMessage}</Message></Response>`);
    }

    // General Inbound Message (Client inquiry or feedback)
    // Attempt to match active client orders by phone
    let linkedOrderId = null;
    if (normalizedSender) {
      const clientOrder = await Order.findOne({
        clientWhatsApp: { $regex: new RegExp(cleanFromPhone.slice(-9) + '$') },
      }).sort({ createdAt: -1 });
      if (clientOrder) {
        linkedOrderId = clientOrder._id;
      }
    }

    await recordInboundNotification({
      from: normalizedSender,
      to: rawTo.replace(/^whatsapp:/i, ''),
      body,
      twilioSid: messageSid,
      channel,
      orderId: linkedOrderId,
      metadata: { rawPayload: req.body },
    });

    res.type('text/xml').send('<Response/>');
  } catch (error) {
    console.error(`[Twilio Inbound Message Error] ${error.message}`);
    res.status(500).type('text/xml').send('<Response/>');
  }
});

// ==========================================
// 2. STAFF & ADMIN MANAGEMENT ENDPOINTS
// ==========================================

router.use(verifyStaffToken, requireRoles('manager', 'admin', 'designer'));

/**
 * GET /api/notifications/history
 * Returns paginated / filtered notification history from MongoDB alongside unread & channel counts.
 */
router.get('/history', async (req, res) => {
  try {
    const { limit = 100, orderId, channel, status, unreadOnly, search } = req.query;
    const notifications = await getNotificationHistory({
      limit: parseInt(limit, 10) || 100,
      orderId: orderId || null,
      channel: channel || null,
      status: status || null,
      unreadOnly: unreadOnly === 'true',
      search: search || '',
      user: req.user,
    });

    const allForSummary = (channel || status || unreadOnly === 'true' || search)
      ? await getNotificationHistory({ limit: 250, user: req.user })
      : notifications;

    const unreadCount = allForSummary.filter(
      (n) => !n.isRead && (n.channel === 'in_system' || !allForSummary.some((other) => other.channel === 'in_system' && other.eventGroupId && other.eventGroupId === n.eventGroupId))
    ).length;

    const channelCounts = {
      all: allForSummary.length,
      in_system: allForSummary.filter((n) => n.channel === 'in_system').length,
      email: allForSummary.filter((n) => n.channel === 'email').length,
      whatsapp: allForSummary.filter((n) => n.channel === 'whatsapp').length,
      sms: allForSummary.filter((n) => n.channel === 'sms').length,
      failed: allForSummary.filter((n) => n.status === 'failed' || n.status === 'undelivered').length,
    };

    res.status(200).json({
      success: true,
      notifications,
      unreadCount,
      channelCounts,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * PATCH /api/notifications/:id/read
 * Marks a notification (and any grouped tri-channel siblings) as read.
 */
router.patch('/:id/read', async (req, res) => {
  try {
    const updated = await markNotificationRead(req.params.id);
    res.status(200).json({ success: true, notification: updated });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/notifications/mark-all-read
 * Marks all unread notifications for the current staff user/role as read.
 */
router.post('/mark-all-read', async (req, res) => {
  try {
    const result = await markAllNotificationsRead(req.user);
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/notifications/resend/:id
 * Manually re-dispatches a notification (with optional channel override).
 */
router.post('/resend/:id', requireRoles('manager', 'admin'), async (req, res) => {
  try {
    const { channel } = req.body;
    const result = await resendNotification(req.params.id, { channelOverride: channel });
    res.status(200).json({ success: true, message: 'Notification re-dispatched', result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/notifications/test-send
 * Dispatches an ad-hoc notification across either a single channel or all 3 channels (In-System + Email + Phone).
 */
router.post('/test-send', requireRoles('manager', 'admin'), async (req, res) => {
  try {
    const {
      to,
      email,
      phone,
      recipientName = '',
      recipientRole = 'client',
      title = 'Taarifa kutoka Tinzel',
      channel = 'whatsapp',
      triChannel = false,
      orderId = null,
      message = 'Jaribio la ujumbe kutoka Tinzel platform',
    } = req.body;

    if (triChannel || (email && phone)) {
      const results = await dispatchTriChannelNotification({
        recipientName: recipientName || email || phone || to || 'Recipient',
        recipientRole,
        email: email || (to && to.includes('@') ? to : ''),
        phone: phone || (to && !to.includes('@') ? to : ''),
        title,
        message,
        template: 'manual_broadcast',
        orderId: orderId || null,
        metadata: { sentBy: req.user?._id, sentByName: req.user?.name },
      });
      return res.status(200).json({
        success: true,
        message: 'Tri-channel notification dispatched across In-System, Email, and Phone.',
        results,
      });
    }

    if (!to && !phone && !email) {
      return res.status(400).json({ success: false, message: 'Namba ya mpokeaji au barua pepe inahitajika' });
    }

    const targetTo = to || phone || email;
    const result = await sendNotification({
      to: targetTo,
      recipientName: recipientName || targetTo,
      recipientRole,
      title,
      channel,
      template: 'manual_test',
      subject: title,
      message,
      orderId: orderId || null,
      metadata: { sentBy: req.user?._id, test: true },
    });

    res.status(200).json({ success: true, message: 'Ujumbe wa majaribio umetumwa', result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/notifications/diagnostics
 * Tests Twilio credentials and reports configuration state.
 */
router.get('/diagnostics', requireRoles('manager', 'admin'), async (_req, res) => {
  try {
    const report = await testTwilioConnection();
    res.status(200).json({ success: true, diagnostics: report });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
