import twilio from 'twilio';
import mongoose from 'mongoose';
import { AuditLog } from '../models/AuditLog.model.js';
import { Notification } from '../models/Notification.model.js';
import { sendEmail, emailTemplates, isEmailConfigured } from './emailService.js';

// In-memory simulation log for development & inspection
const simulatedNotifications = [];

export const getSimulatedNotifications = () => [...simulatedNotifications];
export const clearSimulatedNotifications = () => {
  simulatedNotifications.length = 0;
};

let cachedTwilioClient = null;

/**
 * Checks whether live Twilio credentials are provided.
 */
export const isTwilioConfigured = () => {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_PHONE_NUMBER
  );
};

/**
 * Returns an initialized Twilio client instance if configured.
 */
const getTwilioClient = () => {
  if (cachedTwilioClient) return cachedTwilioClient;
  if (!isTwilioConfigured()) return null;

  cachedTwilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  return cachedTwilioClient;
};

/**
 * Normalizes phone numbers to E.164 format for Twilio.
 * Defaults local 07... numbers to Tanzania (+255) if no country code provided.
 */
export const normalizePhoneNumber = (phone) => {
  if (!phone) return '';
  let cleaned = phone.trim().replace(/[\s\-()]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('0')) {
    const defaultCountry = process.env.DEFAULT_COUNTRY_CODE || '255';
    return `+${defaultCountry}${cleaned.slice(1)}`;
  }
  return `+${cleaned}`;
};

/**
 * Universal dispatcher supporting Email (Google SMTP), SMS (Twilio), WhatsApp (Twilio),
 * and clean local simulation mode.
 */
export const sendNotification = async ({
  to,
  channel = 'whatsapp', // 'whatsapp' | 'sms' | 'email'
  template = 'general',
  subject = null,
  html = null,
  message = '',
  mediaUrl = null,
  metadata = {},
  orderId = null,
  fallbackToSms = true,
}) => {
  const timestamp = new Date().toISOString();
  const logEntry = {
    id: `notif-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    to,
    channel,
    template,
    subject,
    message,
    mediaUrl,
    metadata,
    orderId,
    timestamp,
    status: 'delivered',
  };

  // Channel: EMAIL (Google SMTP via Nodemailer)
  if (channel === 'email') {
    const mailResult = await sendEmail({
      to,
      subject: subject || `Taarifa ya Tinzel: ${template}`,
      html,
      text: message,
    });

    logEntry.mode = mailResult.mode;
    if (mailResult.error) {
      logEntry.error = mailResult.error;
      logEntry.status = 'failed';
    } else {
      logEntry.messageId = mailResult.messageId;
    }
  }

  // Channel: SMS or WHATSAPP (Twilio)
  else if (channel === 'sms' || channel === 'whatsapp') {
    const client = getTwilioClient();

    if (client) {
      const formattedRecipient = normalizePhoneNumber(to);
      const isWhatsApp = channel === 'whatsapp';
      const fromNumber = isWhatsApp
        ? `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER || process.env.TWILIO_PHONE_NUMBER}`
        : process.env.TWILIO_PHONE_NUMBER;

      const toNumber = isWhatsApp
        ? `whatsapp:${formattedRecipient}`
        : formattedRecipient;

      const payload = {
        from: fromNumber,
        to: toNumber,
        body: message,
      };

      if (mediaUrl) {
        payload.mediaUrl = [mediaUrl];
      }

      if (process.env.TWILIO_STATUS_CALLBACK_URL) {
        payload.statusCallback = process.env.TWILIO_STATUS_CALLBACK_URL;
      }

      try {
        const res = await client.messages.create(payload);
        logEntry.sid = res.sid;
        logEntry.mode = 'twilio_live';
        logEntry.status = 'sent';
      } catch (error) {
        console.warn(`[Twilio Error - ${channel.toUpperCase()}] ${error.message}`);

        // Automatic fallback to SMS if WhatsApp fails
        const shouldFallback =
          isWhatsApp &&
          fallbackToSms &&
          process.env.ENABLE_TWILIO_SMS_FALLBACK !== 'false' &&
          process.env.TWILIO_PHONE_NUMBER;

        if (shouldFallback) {
          console.log(`[Twilio WhatsApp Fallback] Falling back to SMS for ${formattedRecipient}...`);
          try {
            const smsPayload = {
              from: process.env.TWILIO_PHONE_NUMBER,
              to: formattedRecipient,
              body: message,
            };
            if (process.env.TWILIO_STATUS_CALLBACK_URL) {
              smsPayload.statusCallback = process.env.TWILIO_STATUS_CALLBACK_URL;
            }
            const smsRes = await client.messages.create(smsPayload);
            logEntry.sid = smsRes.sid;
            logEntry.channel = 'sms';
            logEntry.fallbackFromChannel = 'whatsapp';
            logEntry.mode = 'twilio_fallback_sms';
            logEntry.status = 'sent';
            logEntry.error = null;
          } catch (smsError) {
            console.warn(`[Twilio SMS Fallback Error] ${smsError.message}`);
            logEntry.mode = 'twilio_failed_fallback_simulated';
            logEntry.status = 'failed';
            logEntry.error = `WhatsApp: ${error.message} | SMS: ${smsError.message}`;
          }
        } else {
          logEntry.mode = 'twilio_failed_fallback_simulated';
          logEntry.status = 'failed';
          logEntry.error = error.message;
        }
      }
    } else {
      logEntry.mode = 'simulated';
    }
  } else {
    logEntry.mode = 'unsupported_channel';
    logEntry.status = 'failed';
  }

  // Keep in-memory rolling log for developer visibility & admin dashboard
  simulatedNotifications.unshift(logEntry);
  if (simulatedNotifications.length > 100) simulatedNotifications.pop();

  console.log(`[Notification Engine - ${channel.toUpperCase()}] To: ${to} | Template: ${template} | Mode: ${logEntry.mode}`);

  // Safely persist to Notification collection if DB is connected
  if (mongoose.connection.readyState === 1) {
    try {
      const notifDoc = await Notification.create({
        recipient: to,
        channel: logEntry.channel || channel,
        direction: 'outbound',
        orderId,
        template,
        subject,
        message,
        mediaUrl,
        twilioSid: logEntry.sid || null,
        mode: logEntry.mode,
        status: logEntry.status,
        errorCode: logEntry.errorCode || null,
        errorMessage: logEntry.error || null,
        fallbackFromChannel: logEntry.fallbackFromChannel || null,
        metadata,
      });
      logEntry._id = notifDoc._id;
    } catch {
      // Prevent isolated test environments without collections from throwing
    }
  }

  // Safely persist audit log if an associated order exists and DB is connected
  if (orderId && mongoose.connection.readyState === 1) {
    try {
      await AuditLog.create({
        actor: { type: 'system', name: 'Notification Service' },
        action: `NOTIFICATION_${template.toUpperCase()}`,
        orderId,
        details: {
          to,
          channel: logEntry.channel || channel,
          template,
          mode: logEntry.mode,
          status: logEntry.status,
          fallbackFromChannel: logEntry.fallbackFromChannel || null,
        },
      });
    } catch {
      // Prevent MongoDB connection issues in testing/isolated environments from throwing
    }
  }

  return logEntry;
};


// --- Specialized Milestone Multi-Channel Dispatchers ---

/**
 * Milestone: Payment Verified
 * Sends WhatsApp and Email (if clientEmail is present).
 */
export const notifyPaymentVerified = async (order, trackingUrl) => {
  const notifications = [];

  // WhatsApp
  if (order.clientWhatsApp) {
    const message =
      `Habari ${order.clientName}! Malipo ya jarida lako yamethibitishwa.\n` +
      `Namba yako ya Kufuatilia (Tracking ID) ni: ${order.trackingId}\n` +
      `Unaweza kufuatilia maendeleo ya jarida lako hapa: ${trackingUrl}`;

    notifications.push(
      sendNotification({
        to: order.clientWhatsApp,
        channel: 'whatsapp',
        template: 'payment_verified',
        message,
        orderId: order._id,
      })
    );
  }

  // Email via Google SMTP
  if (order.clientEmail) {
    const templateData = emailTemplates.payment_verified({
      clientName: order.clientName,
      trackingId: order.trackingId,
      trackingUrl,
      formTitle: order.formTitle,
    });

    notifications.push(
      sendNotification({
        to: order.clientEmail,
        channel: 'email',
        template: 'payment_verified',
        subject: templateData.title,
        html: templateData.html,
        message: templateData.text,
        orderId: order._id,
      })
    );
  }

  const results = await Promise.allSettled(notifications);
  return results.map((r) => (r.status === 'fulfilled' ? r.value : { status: 'failed', error: r.reason }));
};

/**
 * Milestone: Draft Released for Client Review
 * Sends WhatsApp and Email (if clientEmail is present).
 */
export const notifyDraftReleased = async (order, trackingUrl) => {
  const notifications = [];

  // WhatsApp
  if (order.clientWhatsApp) {
    const message =
      `Habari ${order.clientName}! Rasimu ya Jarida lako (Toleo la ${order.currentDraftVersion || 1}) ipo tayari kuangaliwa!\n` +
      `Tafadhali ingia hapa kuona kurasa zote za jarida na kutoa idhini au maoni: ${trackingUrl}`;

    notifications.push(
      sendNotification({
        to: order.clientWhatsApp,
        channel: 'whatsapp',
        template: 'draft_released',
        message,
        orderId: order._id,
      })
    );
  }

  // Email via Google SMTP
  if (order.clientEmail) {
    const templateData = emailTemplates.draft_released({
      clientName: order.clientName,
      trackingId: order.trackingId,
      trackingUrl,
      versionNumber: order.currentDraftVersion,
      designerNotes: order.designerNotes,
    });

    notifications.push(
      sendNotification({
        to: order.clientEmail,
        channel: 'email',
        template: 'draft_released',
        subject: templateData.title,
        html: templateData.html,
        message: templateData.text,
        orderId: order._id,
      })
    );
  }

  const results = await Promise.allSettled(notifications);
  return results.map((r) => (r.status === 'fulfilled' ? r.value : { status: 'failed', error: r.reason }));
};

/**
 * Milestone: Dispatch to Print Partner
 * Sends WhatsApp / SMS directly to the designated printing partner.
 */
export const notifyPrinterDispatch = async (order, printerPhone, printUrl, specs = {}) => {
  const message =
    `HABARI PRINTER - ODA MPYA YA KUCHAPA!\n` +
    `Jarida: ${order.formTitle || 'Tinzel Magazine'}\n` +
    `Tracking ID: ${order.trackingId}\n` +
    `Kiasi cha Nakala: ${specs.quantity || 1}\n` +
    `Karatasi: ${specs.paperType || 'Glossy 150gsm'}\n` +
    `Kava: ${specs.coverFinish || 'Laminated Matte'}\n` +
    `Jalada / Binding: ${specs.binding || 'Saddle Stitch'}\n` +
    `Kiungo cha Faili la Print: ${printUrl}\n` +
    `Tafadhali jibu 'POKEA' kuthibitisha kuanza kazi.`;

  return sendNotification({
    to: printerPhone,
    channel: 'whatsapp',
    template: 'print_dispatched',
    message,
    mediaUrl: printUrl,
    orderId: order._id,
  });
};

/**
 * Milestone: Printing In Progress
 * Sends WhatsApp and Email to client.
 */
export const notifyPrintingInProgress = async (order) => {
  const notifications = [];

  if (order.clientWhatsApp) {
    const message =
      `Habari ${order.clientName}! Jarida lako limeanza kuchapwa rasmi kwenye mashine za uchapaji.\n` +
      `Tutakutaarifu pindi litakapokuwa tayari kusafirishwa.`;

    notifications.push(
      sendNotification({
        to: order.clientWhatsApp,
        channel: 'whatsapp',
        template: 'printing_in_progress',
        message,
        orderId: order._id,
      })
    );
  }

  if (order.clientEmail) {
    const templateData = emailTemplates.printing_in_progress({
      clientName: order.clientName,
      trackingId: order.trackingId,
      formTitle: order.formTitle,
    });

    notifications.push(
      sendNotification({
        to: order.clientEmail,
        channel: 'email',
        template: 'printing_in_progress',
        subject: templateData.title,
        html: templateData.html,
        message: templateData.text,
        orderId: order._id,
      })
    );
  }

  const results = await Promise.allSettled(notifications);
  return results.map((r) => (r.status === 'fulfilled' ? r.value : { status: 'failed', error: r.reason }));
};

/**
 * Milestone: Order Dispatched
 * Sends WhatsApp and Email to client with carrier and tracking info.
 */
export const notifyDispatchRecorded = async (order, trackingRef, carrier, trackingUrl = null) => {
  const notifications = [];
  const resolvedTrackingUrl = trackingUrl || `${process.env.FRONTEND_URL || 'http://localhost:5173'}/track`;

  if (order.clientWhatsApp) {
    const message =
      `Habari ${order.clientName}! Jarida lako limekamilika na limesafirishwa!\n` +
      `Msafirishaji: ${carrier || 'Usafiri Maalum'}\n` +
      `Kumbukumbu ya Mzigo: ${trackingRef || 'Inakuja'}\n` +
      `Asante kwa kuchagua Tinzel!`;

    notifications.push(
      sendNotification({
        to: order.clientWhatsApp,
        channel: 'whatsapp',
        template: 'order_dispatched',
        message,
        orderId: order._id,
      })
    );
  }

  if (order.clientEmail) {
    const templateData = emailTemplates.order_dispatched({
      clientName: order.clientName,
      trackingId: order.trackingId,
      trackingReference: trackingRef,
      carrier,
      trackingUrl: resolvedTrackingUrl,
    });

    notifications.push(
      sendNotification({
        to: order.clientEmail,
        channel: 'email',
        template: 'order_dispatched',
        subject: templateData.title,
        html: templateData.html,
        message: templateData.text,
        orderId: order._id,
      })
    );
  }

  const results = await Promise.allSettled(notifications);
  return results.map((r) => (r.status === 'fulfilled' ? r.value : { status: 'failed', error: r.reason }));
};

/**
 * Dispatch Client Login OTP via WhatsApp and Email (if available).
 */
export const notifyClientOtp = async (order, otpCode) => {
  const notifications = [];

  if (order.clientWhatsApp) {
    const message = `Namba yako ya siri (OTP) ya kuingia kwenye mfumo wa Tinzel ni: ${otpCode}. Itatumika kwa dakika 10.`;
    notifications.push(
      sendNotification({
        to: order.clientWhatsApp,
        channel: 'whatsapp',
        template: 'client_otp',
        message,
        orderId: order._id,
      })
    );
  }

  if (order.clientEmail) {
    const templateData = emailTemplates.client_otp({
      clientName: order.clientName,
      otpCode,
      validityMinutes: 10,
    });

    notifications.push(
      sendNotification({
        to: order.clientEmail,
        channel: 'email',
        template: 'client_otp',
        subject: templateData.title,
        html: templateData.html,
        message: templateData.text,
        orderId: order._id,
      })
    );
  }

  const results = await Promise.allSettled(notifications);
  return results.map((r) => (r.status === 'fulfilled' ? r.value : { status: 'failed', error: r.reason }));
};

/**
 * Updates the delivery status of a dispatched Twilio message by SID.
 * Called by Twilio StatusCallback webhooks.
 */
export const updateNotificationDeliveryStatus = async ({
  twilioSid,
  status,
  errorCode = null,
  errorMessage = null,
}) => {
  if (!twilioSid) return null;

  const validStatuses = ['queued', 'sent', 'delivered', 'failed', 'undelivered'];
  const normalizedStatus = validStatuses.includes(status) ? status : 'sent';

  // Update in-memory log entry if present
  const memoryEntry = simulatedNotifications.find((n) => n.sid === twilioSid);
  if (memoryEntry) {
    memoryEntry.status = normalizedStatus;
    if (errorCode) memoryEntry.errorCode = errorCode;
    if (errorMessage) memoryEntry.error = errorMessage;
  }

  // Update persistent MongoDB record
  if (mongoose.connection.readyState === 1) {
    try {
      const updated = await Notification.findOneAndUpdate(
        { twilioSid },
        {
          $set: {
            status: normalizedStatus,
            errorCode: errorCode || null,
            errorMessage: errorMessage || null,
          },
        },
        { returnDocument: 'after' }
      );
      return updated;
    } catch (err) {
      console.warn(`[Notification Status Update Error] ${err.message}`);
    }
  }

  return memoryEntry || null;
};

/**
 * Records an incoming notification (e.g., Twilio Inbound Webhook reply).
 */
export const recordInboundNotification = async ({
  from,
  to,
  body,
  twilioSid,
  channel = 'whatsapp',
  orderId = null,
  metadata = {},
}) => {
  const logEntry = {
    id: `notif-in-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    from,
    to,
    recipient: to,
    channel,
    direction: 'inbound',
    message: body,
    twilioSid,
    orderId,
    mode: 'twilio_inbound',
    status: 'received',
    timestamp: new Date().toISOString(),
    metadata,
  };

  simulatedNotifications.unshift(logEntry);
  if (simulatedNotifications.length > 100) simulatedNotifications.pop();

  if (mongoose.connection.readyState === 1) {
    try {
      const created = await Notification.create({
        recipient: from,
        channel,
        direction: 'inbound',
        message: body,
        twilioSid,
        orderId,
        mode: 'twilio_inbound',
        status: 'received',
        metadata: { ...metadata, to, from },
      });
      return created;
    } catch (err) {
      console.warn(`[Inbound Notification DB Error] ${err.message}`);
    }
  }

  return logEntry;
};

/**
 * Returns full notification history for admin audit & live monitoring.
 */
export const getNotificationHistory = async ({
  limit = 50,
  orderId = null,
  channel = null,
  status = null,
} = {}) => {
  if (mongoose.connection.readyState === 1) {
    try {
      const filter = {};
      if (orderId) filter.orderId = orderId;
      if (channel) filter.channel = channel;
      if (status) filter.status = status;

      const items = await Notification.find(filter)
        .sort({ createdAt: -1 })
        .limit(Math.min(limit, 200))
        .populate('orderId', 'trackingId formTitle clientName status')
        .lean();

      if (items && items.length > 0) {
        return items;
      }
    } catch (err) {
      console.warn(`[Notification History DB Error] ${err.message}`);
    }
  }

  // Fallback to in-memory notifications
  return simulatedNotifications.slice(0, limit);
};

/**
 * Re-sends a failed or existing notification with optional channel override.
 */
export const resendNotification = async (notificationId, { channelOverride = null } = {}) => {
  let original = null;
  if (mongoose.connection.readyState === 1) {
    original = await Notification.findById(notificationId);
  }

  if (!original) {
    original = simulatedNotifications.find((n) => n.id === notificationId || String(n._id) === String(notificationId));
  }

  if (!original) {
    throw new Error('Notification record not found');
  }

  const targetChannel = channelOverride || original.channel;
  const result = await sendNotification({
    to: original.recipient || original.to,
    channel: targetChannel,
    template: original.template || 'resend',
    subject: original.subject,
    message: original.message,
    mediaUrl: original.mediaUrl,
    orderId: original.orderId,
    metadata: {
      ...(original.metadata || {}),
      isResend: true,
      originalNotificationId: original._id || original.id,
    },
  });

  if (mongoose.connection.readyState === 1 && original._id) {
    await Notification.findByIdAndUpdate(original._id, { $inc: { retries: 1 } });
  }

  return result;
};

/**
 * Diagnostics function to test Twilio API connectivity and credentials.
 */
export const testTwilioConnection = async () => {
  const configured = isTwilioConfigured();
  if (!configured) {
    return {
      success: false,
      configured: false,
      mode: 'simulated',
      message: 'Twilio credentials not configured in environment. System is operating in local simulation mode.',
    };
  }

  const client = getTwilioClient();
  try {
    const account = await client.api.v2010.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
    return {
      success: true,
      configured: true,
      mode: 'twilio_live',
      accountName: account.friendlyName,
      status: account.status,
      phoneNumber: process.env.TWILIO_PHONE_NUMBER,
      whatsappNumber: process.env.TWILIO_WHATSAPP_NUMBER || process.env.TWILIO_PHONE_NUMBER,
      message: 'Successfully connected and verified against Twilio API.',
    };
  } catch (error) {
    return {
      success: false,
      configured: true,
      mode: 'error',
      message: `Failed to authenticate with Twilio API: ${error.message}`,
    };
  }
};
