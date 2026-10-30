import twilio from 'twilio';
import mongoose from 'mongoose';
import { AuditLog } from '../models/AuditLog.model.js';
import { Notification } from '../models/Notification.model.js';
import { StaffUser } from '../models/StaffUser.model.js';
import { SystemConfig } from '../models/SystemConfig.model.js';
import { sendEmail, emailTemplates, isEmailConfigured, getEmailHealth } from './emailService.js';
import {
  sendNextSMS,
  getNextSMSHealth,
  isNextSMSConfigured,
  formatTanzanianPhone,
} from './smsService.js';
import { escapeRegex } from '../utils/regexUtils.js';

// In-memory simulation log for development & inspection
const simulatedNotifications = [];
const inSystemNotifications = [];

export const NOTIFICATION_TRIGGER_CATALOG = [
  {
    key: 'order_submitted',
    label: 'Order Submitted (Client & Staff)',
    description: 'Triggered when a client submits a new magazine order form in Pre-Design.',
    category: 'Pre-Design',
    recipient: 'Client & Manager',
    defaults: { enabled: true, in_system: true, email: true, sms: true },
  },
  {
    key: 'payment_verified',
    label: 'Payment Verified & Tracking ID Issued',
    description: 'Triggered when a manager verifies Lipa Namba payment and generates a Tracking ID.',
    category: 'Pre-Design',
    recipient: 'Client',
    defaults: { enabled: true, in_system: true, email: true, sms: true },
  },
  {
    key: 'order_assigned',
    label: 'Designer Assigned to Order',
    description: 'Triggered when an order is assigned or reassigned to an editorial designer.',
    category: 'Design Phase',
    recipient: 'Designer',
    defaults: { enabled: true, in_system: true, email: true, sms: true },
  },
  {
    key: 'draft_uploaded',
    label: 'Draft Uploaded for Manager Review',
    description: 'Triggered when a designer uploads a magazine draft PDF for manager QA.',
    category: 'Design Phase',
    recipient: 'Manager',
    defaults: { enabled: true, in_system: true, email: true, sms: true },
  },
  {
    key: 'draft_released',
    label: 'Draft Released to Client for Proof Review',
    description: 'Triggered when a manager approves a draft and releases it to the client portal.',
    category: 'Design Phase',
    recipient: 'Client',
    defaults: { enabled: true, in_system: true, email: true, sms: true },
  },
  {
    key: 'draft_returned',
    label: 'Draft Returned for Changes (Internal)',
    description: 'Triggered when a manager returns a draft to the designer with revision items.',
    category: 'Returns',
    recipient: 'Designer',
    defaults: { enabled: true, in_system: true, email: true, sms: true },
  },
  {
    key: 'client_revision_requested',
    label: 'Client Requested Revisions',
    description: 'Triggered when a client submits page-by-page revision notes on a draft proof.',
    category: 'Returns',
    recipient: 'Designer & Manager',
    defaults: { enabled: true, in_system: true, email: true, sms: true },
  },
  {
    key: 'client_approved',
    label: 'Client Approved Magazine Proof',
    description: 'Triggered when a client approves the entire magazine proof to enter Post-Design.',
    category: 'Post-Design',
    recipient: 'Designer & Manager',
    defaults: { enabled: true, in_system: true, email: true, sms: true },
  },
  {
    key: 'print_document_uploaded',
    label: 'Print-Ready PDF Uploaded',
    description: 'Triggered when the designer uploads the final high-resolution print PDF.',
    category: 'Post-Design',
    recipient: 'Manager',
    defaults: { enabled: true, in_system: true, email: true, sms: true },
  },
  {
    key: 'print_dispatched',
    label: 'Order Sent to Printing Partner',
    description: 'Triggered when a manager dispatches print specifications to the printing partner.',
    category: 'Post-Design',
    recipient: 'Printer',
    defaults: { enabled: true, in_system: true, email: false, sms: true },
  },
  {
    key: 'printing_in_progress',
    label: 'Printing In Progress',
    description: 'Triggered when the printer confirms order receipt and printing begins.',
    category: 'Post-Design',
    recipient: 'Client',
    defaults: { enabled: true, in_system: true, email: true, sms: true },
  },
  {
    key: 'order_dispatched',
    label: 'Order Dispatched via Courier',
    description: 'Triggered when courier and tracking reference details are recorded for delivery.',
    category: 'Post-Design',
    recipient: 'Client',
    defaults: { enabled: true, in_system: true, email: true, sms: true },
  },
  {
    key: 'order_closed',
    label: 'Order Delivered & Closed',
    description: 'Triggered when final magazine delivery is confirmed and the order is closed.',
    category: 'Post-Design',
    recipient: 'Client & Manager',
    defaults: { enabled: true, in_system: true, email: true, sms: true },
  },
  {
    key: 'client_otp',
    label: 'Client Portal Login OTP',
    description: 'Triggered when a client requests a one-time password to access the tracking portal.',
    category: 'Security',
    recipient: 'Client',
    defaults: { enabled: true, in_system: true, email: true, sms: true },
  },
];

export const buildDefaultNotificationSettings = () => {
  const triggers = {};
  for (const item of NOTIFICATION_TRIGGER_CATALOG) {
    triggers[item.key] = { ...item.defaults };
  }
  return {
    channels: {
      in_system: true,
      email: true,
      sms: true,
    },
    smsSenderId: process.env.NEXTSMS_SENDER_ID || 'ORDER',
    triggers,
  };
};

let inMemoryNotificationSettings = buildDefaultNotificationSettings();

const mergeWithDefaults = (raw = {}) => {
  const base = buildDefaultNotificationSettings();
  const merged = {
    channels: {
      in_system: raw?.channels?.in_system !== undefined ? Boolean(raw.channels.in_system) : base.channels.in_system,
      email: raw?.channels?.email !== undefined ? Boolean(raw.channels.email) : base.channels.email,
      sms: raw?.channels?.sms !== undefined ? Boolean(raw.channels.sms) : base.channels.sms,
    },
    smsSenderId:
      typeof raw?.smsSenderId === 'string' && raw.smsSenderId.trim()
        ? raw.smsSenderId.trim().toUpperCase()
        : base.smsSenderId,
    triggers: { ...base.triggers },
  };

  if (raw?.triggers && typeof raw.triggers === 'object') {
    for (const item of NOTIFICATION_TRIGGER_CATALOG) {
      const incoming = raw.triggers[item.key];
      if (incoming && typeof incoming === 'object') {
        merged.triggers[item.key] = {
          enabled: incoming.enabled !== undefined ? Boolean(incoming.enabled) : item.defaults.enabled,
          in_system: incoming.in_system !== undefined ? Boolean(incoming.in_system) : item.defaults.in_system,
          email: incoming.email !== undefined ? Boolean(incoming.email) : item.defaults.email,
          sms: incoming.sms !== undefined ? Boolean(incoming.sms) : item.defaults.sms,
        };
      }
    }
  }

  return merged;
};

/**
 * Loads active notification settings from MongoDB SystemConfig (or in-memory fallback).
 */
export const getNotificationSettings = async () => {
  if (mongoose.connection.readyState === 1) {
    try {
      const doc = await SystemConfig.findOne({ key: 'notification_settings' }).lean();
      if (doc?.value && typeof doc.value === 'object') {
        inMemoryNotificationSettings = mergeWithDefaults(doc.value);
      }
    } catch {
      // Fallback to in-memory settings
    }
  }
  return {
    ...inMemoryNotificationSettings,
    catalog: NOTIFICATION_TRIGGER_CATALOG,
  };
};

/**
 * Updates notification settings in MongoDB SystemConfig and in-memory cache.
 */
export const updateNotificationSettings = async (updates = {}, updatedBy = null) => {
  const current = await getNotificationSettings();
  const merged = mergeWithDefaults({
    channels: {
      ...current.channels,
      ...(updates.channels || {}),
    },
    smsSenderId: updates.smsSenderId !== undefined ? updates.smsSenderId : current.smsSenderId,
    triggers: {
      ...current.triggers,
      ...(updates.triggers || {}),
    },
  });

  inMemoryNotificationSettings = merged;

  if (mongoose.connection.readyState === 1) {
    try {
      await SystemConfig.findOneAndUpdate(
        { key: 'notification_settings' },
        {
          key: 'notification_settings',
          value: merged,
          description: 'QAMS Notification Triggers & Channel Settings',
          ...(updatedBy ? { updatedBy } : {}),
        },
        { upsert: true, returnDocument: 'after' }
      );
    } catch {
      // Keep in-memory settings updated even if DB write fails
    }
  }

  return {
    ...merged,
    catalog: NOTIFICATION_TRIGGER_CATALOG,
  };
};

/**
 * Resets notification settings to defaults.
 */
export const resetNotificationSettings = async (updatedBy = null) => {
  const defaults = buildDefaultNotificationSettings();
  inMemoryNotificationSettings = defaults;

  if (mongoose.connection.readyState === 1) {
    try {
      await SystemConfig.findOneAndUpdate(
        { key: 'notification_settings' },
        {
          key: 'notification_settings',
          value: defaults,
          description: 'QAMS Notification Triggers & Channel Settings',
          ...(updatedBy ? { updatedBy } : {}),
        },
        { upsert: true, returnDocument: 'after' }
      );
    } catch {
      // Ignore DB error in isolated tests
    }
  }

  return {
    ...defaults,
    catalog: NOTIFICATION_TRIGGER_CATALOG,
  };
};

/**
 * Evaluates whether a given notification template and channel are enabled.
 */
export const isTriggerChannelEnabled = (template, channel, settings = inMemoryNotificationSettings) => {
  const normalizedChannel = channel === 'whatsapp' ? 'sms' : channel;
  if (settings?.channels && settings.channels[normalizedChannel] === false) {
    return false;
  }

  const triggerKey = template === 'order_submitted_staff' ? 'order_submitted' : template;
  const triggerConfig = settings?.triggers?.[triggerKey];
  if (!triggerConfig) {
    return true;
  }
  if (triggerConfig.enabled === false) {
    return false;
  }
  if (triggerConfig[normalizedChannel] === false) {
    return false;
  }
  return true;
};

export const getSimulatedNotifications = () => [...simulatedNotifications];
export const getSimulatedInSystemNotifications = () => [...inSystemNotifications];
export const clearSimulatedNotifications = () => {
  simulatedNotifications.length = 0;
  inSystemNotifications.length = 0;
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
 * In-System Notifications, and clean local simulation mode.
 */
export const sendNotification = async ({
  to,
  recipientName = '',
  recipientRole = 'client',
  recipientUser = null,
  eventGroupId = null,
  title = null,
  channel = 'whatsapp', // 'whatsapp' | 'sms' | 'email' | 'in_system'
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
    recipient: to,
    recipientName,
    recipientRole,
    recipientUser,
    eventGroupId,
    title: title || subject || null,
    channel,
    direction: 'outbound',
    template,
    subject,
    message,
    mediaUrl,
    metadata,
    orderId,
    timestamp,
    createdAt: timestamp,
    isRead: false,
    status: 'delivered',
  };

  if (!metadata?.bypassSettings && !isTriggerChannelEnabled(template, channel)) {
    return {
      ...logEntry,
      mode: 'disabled_by_settings',
      status: 'skipped',
      skipped: true,
    };
  }

  // Channel: IN-SYSTEM Notification
  if (channel === 'in_system') {
    logEntry.mode = 'in_system';
    logEntry.status = 'delivered';
  }

  // Channel: EMAIL (Google SMTP via Nodemailer)
  else if (channel === 'email') {
    const mailResult = await sendEmail({
      to,
      subject: subject || title || `Taarifa ya Tinzel: ${template}`,
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

  // Channel: SMS or WHATSAPP (NextSMS / Twilio)
  else if (channel === 'sms' || channel === 'whatsapp') {
    const client = getTwilioClient();
    const isUnitTestContext = Boolean(process.env.NODE_TEST_CONTEXT) && !metadata?.forceNextSms;
    const useNextSms =
      !isUnitTestContext &&
      isNextSMSConfigured() &&
      (channel === 'sms' || !client);

    if (useNextSms) {
      try {
        const senderId =
          metadata?.senderId ||
          inMemoryNotificationSettings?.smsSenderId ||
          process.env.NEXTSMS_SENDER_ID ||
          'ORDER';
        const formatted = formatTanzanianPhone(to);
        const nextSmsRes = await sendNextSMS(formatted, message, senderId);
        const firstMsg = nextSmsRes?.messages?.[0];
        const isRejected = firstMsg?.status?.groupName === 'REJECTED';

        logEntry.channel = 'sms';
        if (channel === 'whatsapp') {
          logEntry.fallbackFromChannel = 'whatsapp';
        }
        logEntry.mode = 'nextsms_live';
        logEntry.sid = String(firstMsg?.messageId || firstMsg?.sendReference || '');
        logEntry.status = isRejected ? 'failed' : 'sent';
        if (isRejected) {
          logEntry.error =
            firstMsg?.status?.description || firstMsg?.status?.name || 'NextSMS rejected message';
        }
        logEntry.metadata = {
          ...metadata,
          senderId,
          nextSmsStatus: firstMsg?.status || null,
          smsCount: firstMsg?.smsCount ?? 1,
          price: firstMsg?.price ?? null,
        };
      } catch (nextErr) {
        console.warn(`[NextSMS Error] ${nextErr.message}`);
        logEntry.channel = 'sms';
        logEntry.mode = 'nextsms_failed';
        logEntry.status = 'failed';
        logEntry.error = nextErr.message;
      }
    } else if (client) {
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
  if (channel === 'in_system') {
    inSystemNotifications.unshift(logEntry);
    if (inSystemNotifications.length > 150) inSystemNotifications.pop();
  } else {
    simulatedNotifications.unshift(logEntry);
    if (simulatedNotifications.length > 100) simulatedNotifications.pop();
  }

  console.log(`[Notification Engine - ${channel.toUpperCase()}] To: ${to} | Template: ${template} | Mode: ${logEntry.mode}`);

  // Safely persist to Notification collection if DB is connected
  if (mongoose.connection.readyState === 1) {
    try {
      const notifDoc = await Notification.create({
        recipient: to,
        recipientName,
        recipientRole,
        recipientUser: recipientUser || null,
        eventGroupId,
        title: title || subject || null,
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
        isRead: false,
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
  if (orderId && mongoose.connection.readyState === 1 && channel !== 'in_system') {
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

/**
 * Records an in-system notification linked to its companion Email and Phone dispatches.
 */
export const recordInSystemNotification = async ({
  recipient = 'System Inbox',
  recipientName = '',
  recipientRole = 'manager',
  recipientUser = null,
  eventGroupId = null,
  title = 'System Notification',
  template = 'general',
  message = '',
  orderId = null,
  emailTo = '',
  phoneTo = '',
  metadata = {},
}) => {
  const groupId = eventGroupId || `evt-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  return sendNotification({
    to: recipient || recipientName || emailTo || phoneTo || 'in-system',
    recipientName,
    recipientRole,
    recipientUser,
    eventGroupId: groupId,
    title,
    channel: 'in_system',
    template,
    subject: title,
    message,
    orderId,
    metadata: {
      ...metadata,
      channelsSummary: {
        in_system: true,
        email: Boolean(emailTo),
        phone: Boolean(phoneTo),
        emailAddress: emailTo || '',
        phoneNumber: phoneTo || '',
      },
    },
  });
};

/**
 * QAMS-style Unified Tri-Channel Dispatcher:
 * Simultaneously sends an In-System notification, an Email (when email is present),
 * and a Phone notification (WhatsApp with SMS fallback when phone is present).
 */
export const dispatchTriChannelNotification = async ({
  recipientName = '',
  recipientRole = 'manager',
  recipientUser = null,
  email = '',
  phone = '',
  title = 'Taarifa ya Tinzel',
  message = '',
  html = null,
  template = 'general',
  orderId = null,
  mediaUrl = null,
  phoneChannel = 'whatsapp',
  metadata = {},
}) => {
  const eventGroupId = `evt-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const sharedMeta = {
    ...metadata,
    channelsSummary: {
      in_system: true,
      email: Boolean(email),
      phone: Boolean(phone),
      emailAddress: email || '',
      phoneNumber: phone || '',
    },
  };

  const tasks = [
    recordInSystemNotification({
      recipient: recipientName || email || phone || recipientRole,
      recipientName,
      recipientRole,
      recipientUser,
      eventGroupId,
      title,
      template,
      message,
      orderId,
      emailTo: email,
      phoneTo: phone,
      metadata: sharedMeta,
    }),
  ];

  if (phone) {
    tasks.push(
      sendNotification({
        to: phone,
        recipientName,
        recipientRole,
        recipientUser,
        eventGroupId,
        title,
        channel: phoneChannel,
        template,
        subject: title,
        message,
        mediaUrl,
        orderId,
        metadata: sharedMeta,
      })
    );
  }

  if (email) {
    const emailPayload = html
      ? { title, html, text: message }
      : emailTemplates.general_notification({ recipientName, title, message });

    tasks.push(
      sendNotification({
        to: email,
        recipientName,
        recipientRole,
        recipientUser,
        eventGroupId,
        title: emailPayload.title || title,
        channel: 'email',
        template,
        subject: emailPayload.title || title,
        html: emailPayload.html,
        message: emailPayload.text || message,
        orderId,
        metadata: sharedMeta,
      })
    );
  }

  const settled = await Promise.allSettled(tasks);
  return settled.map((r) => (r.status === 'fulfilled' ? r.value : { status: 'failed', error: r.reason }));
};

/**
 * Helper to fetch active staff members by role when DB is connected.
 */
const getActiveStaffByRole = async (roles = ['manager']) => {
  if (mongoose.connection.readyState !== 1) return [];
  try {
    const roleList = Array.isArray(roles) ? roles : [roles];
    return await StaffUser.find({
      role: { $in: roleList },
      isActive: true,
      deletedAt: null,
    })
      .select('_id name email phone role')
      .lean();
  } catch {
    return [];
  }
};


// --- Specialized Milestone Multi-Channel Dispatchers ---

/**
 * Milestone: Order Submitted (Pre-Design)
 * Dispatches tri-channel (In-System + Email + Phone) to Client and active Managers.
 */
export const notifyOrderSubmitted = async (order) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const staffUrl = `${frontendUrl}/staff/pre-design`;
  const clientTemplate = emailTemplates.order_submitted({
    clientName: order.clientName,
    submissionId: order.submissionId,
    formTitle: order.formTitle,
    isStaff: false,
  });

  const dispatches = [
    dispatchTriChannelNotification({
      recipientName: order.clientName,
      recipientRole: 'client',
      email: order.clientEmail,
      phone: order.clientWhatsApp,
      title: clientTemplate.title,
      message: clientTemplate.text,
      html: clientTemplate.html,
      template: 'order_submitted',
      orderId: order._id,
      metadata: { submissionId: order.submissionId, phase: 'pre_design' },
    }),
  ];

  const managers = await getActiveStaffByRole(['manager', 'admin']);
  if (managers.length > 0) {
    for (const mgr of managers) {
      const mgrTemplate = emailTemplates.order_submitted({
        recipientName: mgr.name,
        clientName: order.clientName,
        submissionId: order.submissionId,
        formTitle: order.formTitle,
        isStaff: true,
        staffUrl,
      });
      dispatches.push(
        dispatchTriChannelNotification({
          recipientName: mgr.name,
          recipientRole: mgr.role,
          recipientUser: mgr._id,
          email: mgr.email,
          phone: mgr.phone,
          title: mgrTemplate.title,
          message: mgrTemplate.text,
          html: mgrTemplate.html,
          template: 'order_submitted_staff',
          orderId: order._id,
          metadata: { submissionId: order.submissionId, phase: 'pre_design' },
        })
      );
    }
  } else {
    dispatches.push(
      recordInSystemNotification({
        recipient: 'Manager Team',
        recipientName: 'Production Manager',
        recipientRole: 'manager',
        title: `Oda Mpya Imepokelewa: ${order.submissionId}`,
        template: 'order_submitted_staff',
        message: `Oda mpya (${order.submissionId}) kutoka kwa ${order.clientName} inasubiri uthibitisho wa malipo kwenye Pre-Design.`,
        orderId: order._id,
        emailTo: order.clientEmail,
        phoneTo: order.clientWhatsApp,
        metadata: { submissionId: order.submissionId, phase: 'pre_design' },
      })
    );
  }

  await Promise.allSettled(dispatches);
};

/**
 * Milestone: Payment Verified
 * Sends WhatsApp, Email (if clientEmail is present), and In-System notification.
 */
export const notifyPaymentVerified = async (order, trackingUrl) => {
  const notifications = [];
  const eventGroupId = `evt-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const sharedMeta = {
    trackingId: order.trackingId,
    phase: 'pre_design',
    channelsSummary: {
      in_system: true,
      email: Boolean(order.clientEmail),
      phone: Boolean(order.clientWhatsApp),
      emailAddress: order.clientEmail || '',
      phoneNumber: order.clientWhatsApp || '',
    },
  };

  const summaryMsg =
    `Habari ${order.clientName}! Malipo ya jarida lako yamethibitishwa.\n` +
    `Namba yako ya Kufuatilia (Tracking ID) ni: ${order.trackingId}\n` +
    `Unaweza kufuatilia maendeleo ya jarida lako hapa: ${trackingUrl}`;

  await recordInSystemNotification({
    recipient: order.clientName || order.trackingId,
    recipientName: order.clientName,
    recipientRole: 'manager',
    eventGroupId,
    title: `Malipo Yamethibitishwa: ${order.trackingId}`,
    template: 'payment_verified',
    message: summaryMsg,
    orderId: order._id,
    emailTo: order.clientEmail,
    phoneTo: order.clientWhatsApp,
    metadata: sharedMeta,
  });

  // WhatsApp
  if (order.clientWhatsApp) {
    notifications.push(
      sendNotification({
        to: order.clientWhatsApp,
        recipientName: order.clientName,
        recipientRole: 'client',
        eventGroupId,
        title: `Malipo Yamethibitishwa: ${order.trackingId}`,
        channel: 'whatsapp',
        template: 'payment_verified',
        message: summaryMsg,
        orderId: order._id,
        metadata: sharedMeta,
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
        recipientName: order.clientName,
        recipientRole: 'client',
        eventGroupId,
        title: templateData.title,
        channel: 'email',
        template: 'payment_verified',
        subject: templateData.title,
        html: templateData.html,
        message: templateData.text,
        orderId: order._id,
        metadata: sharedMeta,
      })
    );
  }

  const results = await Promise.allSettled(notifications);
  return results.map((r) => (r.status === 'fulfilled' ? r.value : { status: 'failed', error: r.reason }));
};

/**
 * Milestone: Order Assigned / Reassigned to Designer (Design Phase)
 * Dispatches tri-channel (In-System + Email + Phone) to the assigned Designer.
 */
export const notifyOrderAssigned = async (order, designer) => {
  if (!designer) return [];
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const staffUrl = `${frontendUrl}/staff/design/orders/${order._id}`;
  const trackingLabel = order.trackingId || order.submissionId;

  const tpl = emailTemplates.order_assigned({
    designerName: designer.name,
    trackingId: trackingLabel,
    formTitle: order.formTitle,
    clientName: order.clientName,
    staffUrl,
  });

  return dispatchTriChannelNotification({
    recipientName: designer.name,
    recipientRole: 'designer',
    recipientUser: designer._id,
    email: designer.email,
    phone: designer.phone,
    title: tpl.title,
    message: tpl.text,
    html: tpl.html,
    template: 'order_assigned',
    orderId: order._id,
    metadata: { trackingId: trackingLabel, designerName: designer.name, phase: 'design_phase' },
  });
};

/**
 * Milestone: Draft Uploaded by Designer for Manager Review (Design Phase)
 * Dispatches tri-channel (In-System + Email + Phone) to active Managers.
 */
export const notifyDraftUploaded = async (order, versionNumber) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const staffUrl = `${frontendUrl}/staff/design-phase`;
  const trackingLabel = order.trackingId || order.submissionId;
  const managers = await getActiveStaffByRole(['manager', 'admin']);

  if (managers.length === 0) {
    return [
      await recordInSystemNotification({
        recipient: 'Manager Team',
        recipientName: 'Production Manager',
        recipientRole: 'manager',
        title: `Rasimu V${versionNumber || 1} Inasubiri Mapitio: ${trackingLabel}`,
        template: 'draft_uploaded',
        message: `Rasimu V${versionNumber || 1} ya oda ${trackingLabel} (${order.clientName}) imepakiwa na inasubiri mapitio yako ya Meneja.`,
        orderId: order._id,
        metadata: { trackingId: trackingLabel, versionNumber, phase: 'design_phase' },
      }),
    ];
  }

  const tasks = managers.map((mgr) => {
    const tpl = emailTemplates.draft_uploaded({
      managerName: mgr.name,
      trackingId: trackingLabel,
      formTitle: order.formTitle,
      clientName: order.clientName,
      versionNumber,
      staffUrl,
    });
    return dispatchTriChannelNotification({
      recipientName: mgr.name,
      recipientRole: mgr.role,
      recipientUser: mgr._id,
      email: mgr.email,
      phone: mgr.phone,
      title: tpl.title,
      message: tpl.text,
      html: tpl.html,
      template: 'draft_uploaded',
      orderId: order._id,
      metadata: { trackingId: trackingLabel, versionNumber, phase: 'design_phase' },
    });
  });

  return Promise.allSettled(tasks);
};

/**
 * Milestone: Draft Released for Client Review
 * Sends WhatsApp, Email (if clientEmail is present), and In-System notification.
 */
export const notifyDraftReleased = async (order, trackingUrl) => {
  const notifications = [];
  const eventGroupId = `evt-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const sharedMeta = {
    trackingId: order.trackingId,
    versionNumber: order.currentDraftVersion || 1,
    phase: 'design_phase',
    channelsSummary: {
      in_system: true,
      email: Boolean(order.clientEmail),
      phone: Boolean(order.clientWhatsApp),
      emailAddress: order.clientEmail || '',
      phoneNumber: order.clientWhatsApp || '',
    },
  };

  const message =
    `Habari ${order.clientName}! Rasimu ya Jarida lako (Toleo la ${order.currentDraftVersion || 1}) ipo tayari kuangaliwa!\n` +
    `Tafadhali ingia hapa kuona kurasa zote za jarida na kutoa idhini au maoni: ${trackingUrl}`;

  await recordInSystemNotification({
    recipient: order.clientName || order.trackingId,
    recipientName: order.clientName,
    recipientRole: 'manager',
    eventGroupId,
    title: `Rasimu V${order.currentDraftVersion || 1} Imetumwa kwa Mteja: ${order.trackingId}`,
    template: 'draft_released',
    message,
    orderId: order._id,
    emailTo: order.clientEmail,
    phoneTo: order.clientWhatsApp,
    metadata: sharedMeta,
  });

  // WhatsApp
  if (order.clientWhatsApp) {
    notifications.push(
      sendNotification({
        to: order.clientWhatsApp,
        recipientName: order.clientName,
        recipientRole: 'client',
        eventGroupId,
        title: `Rasimu ya Jarida Ipo Tayari (Toleo la ${order.currentDraftVersion || 1})`,
        channel: 'whatsapp',
        template: 'draft_released',
        message,
        orderId: order._id,
        metadata: sharedMeta,
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
        recipientName: order.clientName,
        recipientRole: 'client',
        eventGroupId,
        title: templateData.title,
        channel: 'email',
        template: 'draft_released',
        subject: templateData.title,
        html: templateData.html,
        message: templateData.text,
        orderId: order._id,
        metadata: sharedMeta,
      })
    );
  }

  const results = await Promise.allSettled(notifications);
  return results.map((r) => (r.status === 'fulfilled' ? r.value : { status: 'failed', error: r.reason }));
};

/**
 * Milestone: Draft Returned for Changes (Manager or Client Revision Request -> Returns Page)
 * Dispatches tri-channel (In-System + Email + Phone) to the assigned Designer and active Managers.
 */
export const notifyDraftReturned = async (order, revisionRequest, source = 'manager') => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const staffUrl = `${frontendUrl}/staff/returns`;
  const trackingLabel = order.trackingId || order.submissionId;
  const items = revisionRequest?.items || [];
  const roundNumber = revisionRequest?.roundNumber || 1;

  let designer = null;
  if (order.assignedDesigner && mongoose.connection.readyState === 1) {
    try {
      const designerId = order.assignedDesigner._id || order.assignedDesigner;
      designer = await StaffUser.findById(designerId).select('_id name email phone role').lean();
    } catch {
      designer = null;
    }
  }

  const dispatches = [];
  if (designer) {
    const tpl = emailTemplates.draft_returned({
      recipientName: designer.name,
      trackingId: trackingLabel,
      formTitle: order.formTitle,
      clientName: order.clientName,
      roundNumber,
      items,
      source,
      staffUrl,
    });
    dispatches.push(
      dispatchTriChannelNotification({
        recipientName: designer.name,
        recipientRole: 'designer',
        recipientUser: designer._id,
        email: designer.email,
        phone: designer.phone,
        title: tpl.title,
        message: tpl.text,
        html: tpl.html,
        template: source === 'client' ? 'client_revision_requested' : 'draft_returned',
        orderId: order._id,
        metadata: { trackingId: trackingLabel, roundNumber, source, phase: 'returns' },
      })
    );
  }

  if (source === 'client') {
    const managers = await getActiveStaffByRole(['manager', 'admin']);
    for (const mgr of managers) {
      const tpl = emailTemplates.draft_returned({
        recipientName: mgr.name,
        trackingId: trackingLabel,
        formTitle: order.formTitle,
        clientName: order.clientName,
        roundNumber,
        items,
        source: 'client',
        staffUrl,
      });
      dispatches.push(
        dispatchTriChannelNotification({
          recipientName: mgr.name,
          recipientRole: mgr.role,
          recipientUser: mgr._id,
          email: mgr.email,
          phone: mgr.phone,
          title: tpl.title,
          message: tpl.text,
          html: tpl.html,
          template: 'client_revision_requested',
          orderId: order._id,
          metadata: { trackingId: trackingLabel, roundNumber, source: 'client', phase: 'returns' },
        })
      );
    }
  }

  if (dispatches.length === 0) {
    dispatches.push(
      recordInSystemNotification({
        recipient: 'Returns Queue',
        recipientName: designer?.name || 'Editorial Team',
        recipientRole: 'manager',
        title: `Jarida Limerudishwa kwa Marekebisho: ${trackingLabel} (Duru ya ${roundNumber})`,
        template: source === 'client' ? 'client_revision_requested' : 'draft_returned',
        message: `Jarida ${trackingLabel} (${order.clientName}) limerudishwa kwa marekebisho (${items.length} fix items).`,
        orderId: order._id,
        metadata: { trackingId: trackingLabel, roundNumber, source, phase: 'returns' },
      })
    );
  }

  return Promise.allSettled(dispatches);
};

/**
 * Milestone: Client Approved Whole Magazine (Transition to Post-Design Phase)
 * Dispatches tri-channel (In-System + Email + Phone) to Assigned Designer and Managers.
 */
export const notifyClientApproved = async (order) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const staffUrl = `${frontendUrl}/staff/post-design`;
  const trackingLabel = order.trackingId || order.submissionId;

  const recipients = await getActiveStaffByRole(['manager', 'admin']);
  if (order.assignedDesigner && mongoose.connection.readyState === 1) {
    try {
      const designerId = order.assignedDesigner._id || order.assignedDesigner;
      const designer = await StaffUser.findById(designerId).select('_id name email phone role').lean();
      if (designer) recipients.push(designer);
    } catch {
      // ignore
    }
  }

  if (recipients.length === 0) {
    return [
      await recordInSystemNotification({
        recipient: 'Production Team',
        recipientName: 'Production Manager',
        recipientRole: 'manager',
        title: `Mteja Ameidhinisha Jarida: ${trackingLabel}`,
        template: 'client_approved',
        message: `Mteja ${order.clientName} ameidhinisha jarida zima la oda ${trackingLabel}. Oda imeingia Post-Design Phase.`,
        orderId: order._id,
        metadata: { trackingId: trackingLabel, phase: 'post_design' },
      }),
    ];
  }

  const tasks = recipients.map((staff) => {
    const tpl = emailTemplates.client_approved({
      recipientName: staff.name,
      trackingId: trackingLabel,
      formTitle: order.formTitle,
      clientName: order.clientName,
      versionNumber: order.approvedVersionNumber || order.currentDraftVersion || 1,
      staffUrl,
    });
    return dispatchTriChannelNotification({
      recipientName: staff.name,
      recipientRole: staff.role,
      recipientUser: staff._id,
      email: staff.email,
      phone: staff.phone,
      title: tpl.title,
      message: tpl.text,
      html: tpl.html,
      template: 'client_approved',
      orderId: order._id,
      metadata: { trackingId: trackingLabel, phase: 'post_design' },
    });
  });

  return Promise.allSettled(tasks);
};

/**
 * Milestone: Print-Ready Document Uploaded (Post-Design Phase)
 * Dispatches tri-channel (In-System + Email + Phone) to active Managers.
 */
export const notifyPrintDocumentUploaded = async (order) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const staffUrl = `${frontendUrl}/staff/post-design`;
  const trackingLabel = order.trackingId || order.submissionId;
  const managers = await getActiveStaffByRole(['manager', 'admin']);

  if (managers.length === 0) {
    return [
      await recordInSystemNotification({
        recipient: 'Manager Team',
        recipientName: 'Production Manager',
        recipientRole: 'manager',
        title: `Faili la Print Lipo Tayari kwa Idhini: ${trackingLabel}`,
        template: 'print_document_uploaded',
        message: `Faili la Print-Ready PDF kwa oda ${trackingLabel} (${order.clientName}) limepakiwa na linasubiri idhini kwenye Post-Design Phase.`,
        orderId: order._id,
        metadata: { trackingId: trackingLabel, phase: 'post_design' },
      }),
    ];
  }

  const tasks = managers.map((mgr) => {
    const tpl = emailTemplates.print_document_uploaded({
      recipientName: mgr.name,
      trackingId: trackingLabel,
      formTitle: order.formTitle,
      clientName: order.clientName,
      specs: order.printDocument?.specs || {},
      staffUrl,
    });
    return dispatchTriChannelNotification({
      recipientName: mgr.name,
      recipientRole: mgr.role,
      recipientUser: mgr._id,
      email: mgr.email,
      phone: mgr.phone,
      title: tpl.title,
      message: tpl.text,
      html: tpl.html,
      template: 'print_document_uploaded',
      orderId: order._id,
      metadata: { trackingId: trackingLabel, phase: 'post_design' },
    });
  });

  return Promise.allSettled(tasks);
};

/**
 * Milestone: Dispatch to Print Partner
 * Sends WhatsApp / SMS directly to the designated printing partner and records In-System notification.
 */
export const notifyPrinterDispatch = async (order, printerPhone, printUrl, specs = {}) => {
  const eventGroupId = `evt-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
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

  await recordInSystemNotification({
    recipient: printerPhone,
    recipientName: 'Printing Partner',
    recipientRole: 'manager',
    eventGroupId,
    title: `Imepelekwa kwa Mchapaji: ${order.trackingId}`,
    template: 'print_dispatched',
    message,
    orderId: order._id,
    phoneTo: printerPhone,
    metadata: { trackingId: order.trackingId, phase: 'post_design' },
  });

  return sendNotification({
    to: printerPhone,
    recipientName: 'Printing Partner',
    recipientRole: 'printer',
    eventGroupId,
    title: `Imepelekwa kwa Mchapaji: ${order.trackingId}`,
    channel: 'whatsapp',
    template: 'print_dispatched',
    message,
    mediaUrl: printUrl,
    orderId: order._id,
  });
};

/**
 * Milestone: Printing In Progress
 * Sends WhatsApp, Email, and In-System notification.
 */
export const notifyPrintingInProgress = async (order) => {
  const notifications = [];
  const eventGroupId = `evt-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const sharedMeta = {
    trackingId: order.trackingId,
    phase: 'post_design',
    channelsSummary: {
      in_system: true,
      email: Boolean(order.clientEmail),
      phone: Boolean(order.clientWhatsApp),
      emailAddress: order.clientEmail || '',
      phoneNumber: order.clientWhatsApp || '',
    },
  };

  const message =
    `Habari ${order.clientName}! Jarida lako limeanza kuchapwa rasmi kwenye mashine za uchapaji.\n` +
    `Tutakutaarifu pindi litakapokuwa tayari kusafirishwa.`;

  await recordInSystemNotification({
    recipient: order.clientName || order.trackingId,
    recipientName: order.clientName,
    recipientRole: 'manager',
    eventGroupId,
    title: `Uchapaji Umeanza: ${order.trackingId}`,
    template: 'printing_in_progress',
    message,
    orderId: order._id,
    emailTo: order.clientEmail,
    phoneTo: order.clientWhatsApp,
    metadata: sharedMeta,
  });

  if (order.clientWhatsApp) {
    notifications.push(
      sendNotification({
        to: order.clientWhatsApp,
        recipientName: order.clientName,
        recipientRole: 'client',
        eventGroupId,
        title: `Uchapaji Umeanza: ${order.trackingId}`,
        channel: 'whatsapp',
        template: 'printing_in_progress',
        message,
        orderId: order._id,
        metadata: sharedMeta,
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
        recipientName: order.clientName,
        recipientRole: 'client',
        eventGroupId,
        title: templateData.title,
        channel: 'email',
        template: 'printing_in_progress',
        subject: templateData.title,
        html: templateData.html,
        message: templateData.text,
        orderId: order._id,
        metadata: sharedMeta,
      })
    );
  }

  const results = await Promise.allSettled(notifications);
  return results.map((r) => (r.status === 'fulfilled' ? r.value : { status: 'failed', error: r.reason }));
};

/**
 * Milestone: Order Dispatched
 * Sends WhatsApp, Email, and In-System notification to client with carrier and tracking info.
 */
export const notifyDispatchRecorded = async (order, trackingRef, carrier, trackingUrl = null) => {
  const notifications = [];
  const resolvedTrackingUrl = trackingUrl || `${process.env.FRONTEND_URL || 'http://localhost:5173'}/track`;
  const eventGroupId = `evt-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const sharedMeta = {
    trackingId: order.trackingId,
    carrier,
    trackingReference: trackingRef,
    phase: 'post_design',
    channelsSummary: {
      in_system: true,
      email: Boolean(order.clientEmail),
      phone: Boolean(order.clientWhatsApp),
      emailAddress: order.clientEmail || '',
      phoneNumber: order.clientWhatsApp || '',
    },
  };

  const message =
    `Habari ${order.clientName}! Jarida lako limekamilika na limesafirishwa!\n` +
    `Msafirishaji: ${carrier || 'Usafiri Maalum'}\n` +
    `Kumbukumbu ya Mzigo: ${trackingRef || 'Inakuja'}\n` +
    `Asante kwa kuchagua Tinzel!`;

  await recordInSystemNotification({
    recipient: order.clientName || order.trackingId,
    recipientName: order.clientName,
    recipientRole: 'manager',
    eventGroupId,
    title: `Jarida Limesafirishwa: ${order.trackingId}`,
    template: 'order_dispatched',
    message,
    orderId: order._id,
    emailTo: order.clientEmail,
    phoneTo: order.clientWhatsApp,
    metadata: sharedMeta,
  });

  if (order.clientWhatsApp) {
    notifications.push(
      sendNotification({
        to: order.clientWhatsApp,
        recipientName: order.clientName,
        recipientRole: 'client',
        eventGroupId,
        title: `Jarida Limesafirishwa: ${order.trackingId}`,
        channel: 'whatsapp',
        template: 'order_dispatched',
        message,
        orderId: order._id,
        metadata: sharedMeta,
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
        recipientName: order.clientName,
        recipientRole: 'client',
        eventGroupId,
        title: templateData.title,
        channel: 'email',
        template: 'order_dispatched',
        subject: templateData.title,
        html: templateData.html,
        message: templateData.text,
        orderId: order._id,
        metadata: sharedMeta,
      })
    );
  }

  const results = await Promise.allSettled(notifications);
  return results.map((r) => (r.status === 'fulfilled' ? r.value : { status: 'failed', error: r.reason }));
};

/**
 * Milestone: Order Delivered & Closed (Post-Design Phase)
 * Dispatches tri-channel (In-System + Email + Phone) to Client and Staff.
 */
export const notifyOrderClosed = async (order, deliveryDetails = {}) => {
  const trackingLabel = order.trackingId || order.submissionId;
  const tpl = emailTemplates.order_closed({
    recipientName: order.clientName,
    trackingId: trackingLabel,
    formTitle: order.formTitle,
    recipientConfirmed: deliveryDetails.recipientName || order.clientName,
    confirmationMethod: deliveryDetails.confirmationMethod,
  });

  return dispatchTriChannelNotification({
    recipientName: order.clientName,
    recipientRole: 'manager',
    email: order.clientEmail,
    phone: order.clientWhatsApp,
    title: tpl.title,
    message: tpl.text,
    html: tpl.html,
    template: 'order_closed',
    orderId: order._id,
    metadata: { trackingId: trackingLabel, phase: 'post_design' },
  });
};

/**
 * Dispatch Client Login OTP via WhatsApp, Email (if available), and In-System log.
 */
export const notifyClientOtp = async (order, otpCode) => {
  const notifications = [];
  const eventGroupId = `evt-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const sharedMeta = {
    trackingId: order.trackingId,
    channelsSummary: {
      in_system: true,
      email: Boolean(order.clientEmail),
      phone: Boolean(order.clientWhatsApp),
      emailAddress: order.clientEmail || '',
      phoneNumber: order.clientWhatsApp || '',
    },
  };

  const message = `Namba yako ya siri (OTP) ya kuingia kwenye mfumo wa Tinzel ni: ${otpCode}. Itatumika kwa dakika 10.`;

  await recordInSystemNotification({
    recipient: order.clientName || order.clientWhatsApp,
    recipientName: order.clientName,
    recipientRole: 'manager',
    eventGroupId,
    title: `OTP ya Mteja Imetumwa: ${order.trackingId || order.clientName}`,
    template: 'client_otp',
    message,
    orderId: order._id,
    emailTo: order.clientEmail,
    phoneTo: order.clientWhatsApp,
    metadata: sharedMeta,
  });

  if (order.clientWhatsApp) {
    notifications.push(
      sendNotification({
        to: order.clientWhatsApp,
        recipientName: order.clientName,
        recipientRole: 'client',
        eventGroupId,
        title: 'Namba Yako ya Siri (OTP) ya Kuingia',
        channel: 'whatsapp',
        template: 'client_otp',
        message,
        orderId: order._id,
        metadata: sharedMeta,
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
        recipientName: order.clientName,
        recipientRole: 'client',
        eventGroupId,
        title: templateData.title,
        channel: 'email',
        template: 'client_otp',
        subject: templateData.title,
        html: templateData.html,
        message: templateData.text,
        orderId: order._id,
        metadata: sharedMeta,
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
 * Returns full notification history for manager, designer, & admin audit and live monitoring.
 */
export const getNotificationHistory = async ({
  limit = 100,
  orderId = null,
  channel = null,
  status = null,
  unreadOnly = false,
  search = '',
  user = null,
} = {}) => {
  if (mongoose.connection.readyState === 1) {
    try {
      const filter = {};
      if (orderId) filter.orderId = orderId;
      if (channel && channel !== 'all') {
        if (channel === 'phone') {
          filter.channel = { $in: ['whatsapp', 'sms'] };
        } else {
          filter.channel = channel;
        }
      }
      if (status && status !== 'all') filter.status = status;
      if (unreadOnly) filter.isRead = false;

      if (user?.role === 'designer') {
        filter.$or = [
          { recipientUser: user._id },
          { recipientRole: { $in: ['designer', 'all'] } },
          { recipient: user.email },
          ...(user.phone ? [{ recipient: user.phone }] : []),
        ];
      }

      if (search && search.trim()) {
        const safeSearch = escapeRegex(search);
        const rx = new RegExp(safeSearch, 'i');
        const searchOr = [
          { recipient: rx },
          { recipientName: rx },
          { title: rx },
          { subject: rx },
          { message: rx },
          { template: rx },
        ];
        if (filter.$or) {
          filter.$and = [{ $or: filter.$or }, { $or: searchOr }];
          delete filter.$or;
        } else {
          filter.$or = searchOr;
        }
      }

      const items = await Notification.find(filter)
        .sort({ createdAt: -1 })
        .limit(Math.min(limit, 300))
        .populate('orderId', 'trackingId submissionId formTitle clientName status')
        .lean();

      if (items && items.length > 0) {
        return items;
      }
    } catch (err) {
      console.warn(`[Notification History DB Error] ${err.message}`);
    }
  }

  // Fallback to in-memory notifications (merges in-system and external simulated notifications)
  const combined = [...simulatedNotifications, ...inSystemNotifications].sort(
    (a, b) => new Date(b.createdAt || b.timestamp || 0) - new Date(a.createdAt || a.timestamp || 0)
  );

  return combined
    .filter((item) => {
      if (orderId && String(item.orderId) !== String(orderId)) return false;
      if (channel && channel !== 'all') {
        if (channel === 'phone') {
          if (!['whatsapp', 'sms'].includes(item.channel)) return false;
        } else if (item.channel !== channel) {
          return false;
        }
      }
      if (status && status !== 'all' && item.status !== status) return false;
      if (unreadOnly && item.isRead) return false;
      if (search && search.trim()) {
        const q = search.trim().toLowerCase();
        const hay = [item.recipient, item.to, item.recipientName, item.title, item.subject, item.message, item.template]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .slice(0, limit);
};

/**
 * Marks a single notification (and any siblings sharing its eventGroupId) as read.
 */
export const markNotificationRead = async (notificationId) => {
  const now = new Date();

  const allMemoryLists = [inSystemNotifications, simulatedNotifications];
  let matchedGroupId = null;

  for (const list of allMemoryLists) {
    const found = list.find((n) => n.id === notificationId || String(n._id) === String(notificationId));
    if (found) {
      found.isRead = true;
      found.readAt = now.toISOString();
      if (found.eventGroupId) {
        matchedGroupId = found.eventGroupId;
      }
    }
  }

  if (matchedGroupId) {
    for (const list of allMemoryLists) {
      for (const sub of list) {
        if (sub.eventGroupId === matchedGroupId) {
          sub.isRead = true;
          sub.readAt = now.toISOString();
        }
      }
    }
  }

  if (mongoose.connection.readyState === 1 && mongoose.isValidObjectId(notificationId)) {
    const doc = await Notification.findByIdAndUpdate(
      notificationId,
      { $set: { isRead: true, readAt: now } },
      { returnDocument: 'after' }
    ).lean();

    if (doc?.eventGroupId) {
      await Notification.updateMany(
        { eventGroupId: doc.eventGroupId },
        { $set: { isRead: true, readAt: now } }
      );
    }
    return doc;
  }

  return { id: notificationId, isRead: true, readAt: now.toISOString() };
};

/**
 * Marks all unread notifications as read for the given staff user/role.
 */
export const markAllNotificationsRead = async (user = null) => {
  const now = new Date();

  for (const list of [inSystemNotifications, simulatedNotifications]) {
    for (const item of list) {
      item.isRead = true;
      item.readAt = now.toISOString();
    }
  }

  if (mongoose.connection.readyState === 1) {
    const filter = { isRead: false };
    if (user?.role === 'designer') {
      filter.$or = [
        { recipientUser: user._id },
        { recipientRole: { $in: ['designer', 'all'] } },
        { recipient: user.email },
      ];
    }
    const res = await Notification.updateMany(filter, { $set: { isRead: true, readAt: now } });
    return { modifiedCount: res.modifiedCount || 0 };
  }

  return { modifiedCount: inSystemNotifications.length };
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

/**
 * Returns a unified QAMS diagnostics report covering NextSMS, Google SMTP Email, Twilio, and active settings.
 */
export const getUnifiedDiagnostics = async () => {
  const [smsHealth, emailHealth, twilioHealth, settings] = await Promise.all([
    getNextSMSHealth(),
    getEmailHealth(),
    testTwilioConnection(),
    getNotificationSettings(),
  ]);

  const primarySmsHealthy = Boolean(smsHealth.authenticated);
  const primaryEmailHealthy = Boolean(emailHealth.connected);

  return {
    mode: primarySmsHealthy ? 'nextsms_live' : twilioHealth.mode,
    configured: Boolean(smsHealth.configured || emailHealth.configured || twilioHealth.configured),
    sms: smsHealth,
    email: emailHealth,
    twilio: twilioHealth,
    inSystem: {
      configured: true,
      connected: true,
      mode: 'in_system',
      enabled: settings.channels.in_system,
      message: 'In-system staff & client notification inbox is active.',
    },
    settings: {
      channels: settings.channels,
      smsSenderId: settings.smsSenderId,
    },
    message: primarySmsHealthy
      ? `NextSMS Live (${smsHealth.balance?.display || 'Connected'}) | Email: ${
          primaryEmailHealthy ? 'SMTP Live' : 'Simulation Mode'
        }`
      : smsHealth.message,
  };
};

/**
 * Executes an interactive SMS health test via NextSMS and logs the result to Notification history.
 */
export const runSmsHealthTest = async ({ to, message, from, user = null }) => {
  const startedAt = Date.now();
  const settings = await getNotificationSettings();
  const senderId = (from || settings.smsSenderId || process.env.NEXTSMS_SENDER_ID || 'ORDER').trim();
  const formattedPhone = formatTanzanianPhone(to);
  const testMessage =
    (message && message.trim()) ||
    `Tinzel SMS Health Check: Gateway verified at ${new Date().toISOString()}.`;

  const notif = await sendNotification({
    to: formattedPhone,
    recipientName: user?.name || 'SMS Health Test',
    recipientRole: user?.role || 'admin',
    recipientUser: user?._id || null,
    title: `SMS Health Test (${senderId})`,
    channel: 'sms',
    template: 'manual_test',
    subject: `SMS Health Test (${senderId})`,
    message: testMessage,
    metadata: {
      bypassSettings: true,
      forceNextSms: true,
      healthTest: true,
      senderId,
      triggeredBy: user?.email || 'system',
    },
  });

  const latencyMs = Date.now() - startedAt;
  const succeeded = notif.status === 'sent' || notif.status === 'delivered';

  return {
    success: succeeded,
    latencyMs,
    to: formattedPhone,
    senderId,
    mode: notif.mode,
    status: notif.status,
    messageId: notif.sid || null,
    nextSmsStatus: notif.metadata?.nextSmsStatus || null,
    smsCount: notif.metadata?.smsCount ?? 1,
    price: notif.metadata?.price ?? null,
    error: notif.error || null,
    notification: notif,
  };
};

/**
 * Executes an interactive Email health test via Google SMTP (or simulation fallback) and logs to history.
 */
export const runEmailHealthTest = async ({ to, subject, message, user = null }) => {
  if (!to || typeof to !== 'string' || !to.includes('@')) {
    const error = new Error('A valid recipient email address ("to") is required.');
    error.status = 400;
    throw error;
  }

  const startedAt = Date.now();
  const resolvedSubject =
    (subject && subject.trim()) || 'Tinzel Email Health Check - SMTP Diagnostic';
  const resolvedMessage =
    (message && message.trim()) ||
    `This is an automated Email Health Check dispatched from the Tinzel Notification Center at ${new Date().toISOString()}.`;

  const tpl = emailTemplates.general_notification({
    recipientName: user?.name || to.split('@')[0],
    title: resolvedSubject,
    message: resolvedMessage,
  });

  const notif = await sendNotification({
    to: to.trim(),
    recipientName: user?.name || to.trim(),
    recipientRole: user?.role || 'admin',
    recipientUser: user?._id || null,
    title: resolvedSubject,
    channel: 'email',
    template: 'manual_test',
    subject: resolvedSubject,
    html: tpl.html,
    message: resolvedMessage,
    metadata: {
      bypassSettings: true,
      healthTest: true,
      triggeredBy: user?.email || 'system',
    },
  });

  const latencyMs = Date.now() - startedAt;
  const succeeded = notif.status !== 'failed';

  return {
    success: succeeded,
    latencyMs,
    to: to.trim(),
    subject: resolvedSubject,
    mode: notif.mode,
    status: notif.status,
    messageId: notif.messageId || null,
    error: notif.error || null,
    notification: notif,
  };
};
