import { AuditLog } from '../models/AuditLog.model.js';

// In-memory simulation log for development & inspection
const simulatedNotifications = [];

export const getSimulatedNotifications = () => [...simulatedNotifications];
export const clearSimulatedNotifications = () => {
  simulatedNotifications.length = 0;
};

/**
 * Universal dispatcher supporting both Twilio WhatsApp/SMS and clean local simulation.
 */
export const sendNotification = async ({
  to,
  channel = 'whatsapp', // 'whatsapp' | 'sms'
  template,
  message,
  mediaUrl = null,
  metadata = {},
  orderId = null,
}) => {
  const timestamp = new Date().toISOString();
  const logEntry = {
    id: `notif-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    to,
    channel,
    template,
    message,
    mediaUrl,
    metadata,
    orderId,
    timestamp,
    status: 'delivered',
  };

  // Check if live Twilio is configured
  const hasTwilio =
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_PHONE_NUMBER;

  if (hasTwilio) {
    try {
      // Dynamic import to allow running without twilio SDK if not required
      const twilioModule = await import('twilio');
      const client = twilioModule.default(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
      );

      const fromNumber =
        channel === 'whatsapp'
          ? `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER || process.env.TWILIO_PHONE_NUMBER}`
          : process.env.TWILIO_PHONE_NUMBER;

      const toNumber = channel === 'whatsapp' && !to.startsWith('whatsapp:') ? `whatsapp:${to}` : to;

      const payload = {
        from: fromNumber,
        to: toNumber,
        body: message,
      };

      if (mediaUrl) {
        payload.mediaUrl = [mediaUrl];
      }

      const res = await client.messages.create(payload);
      logEntry.sid = res.sid;
      logEntry.mode = 'twilio_live';
    } catch (error) {
      console.warn(`[Twilio Error] Failed to send via live Twilio: ${error.message}. Recorded in simulated log.`);
      logEntry.mode = 'twilio_failed_fallback_simulated';
      logEntry.error = error.message;
    }
  } else {
    logEntry.mode = 'simulated';
  }

  simulatedNotifications.unshift(logEntry);
  if (simulatedNotifications.length > 100) simulatedNotifications.pop();

  console.log(`[Notification Engine - ${channel.toUpperCase()}] To: ${to} | Template: ${template}`);
  console.log(`[Message Content]: ${message}`);

  if (orderId) {
    await AuditLog.create({
      actor: { type: 'system', name: 'Notification Service' },
      action: `NOTIFICATION_${template.toUpperCase()}`,
      orderId,
      details: {
        to,
        channel,
        template,
        mode: logEntry.mode,
      },
    });
  }

  return logEntry;
};

// Specialized milestone dispatchers:
export const notifyPaymentVerified = async (order, trackingUrl) => {
  const message =
    `Habari ${order.clientName}! Malipo ya jarida lako yamethibitishwa.\n` +
    `Namba yako ya Kufuatilia (Tracking ID) ni: ${order.trackingId}\n` +
    `Unaweza kufuatilia maendeleo ya jarida lako hapa: ${trackingUrl}`;

  return sendNotification({
    to: order.clientWhatsApp,
    channel: 'whatsapp',
    template: 'payment_verified',
    message,
    orderId: order._id,
  });
};

export const notifyDraftReleased = async (order, trackingUrl) => {
  const message =
    `Habari ${order.clientName}! Rasimu ya Jarida lako (Toleo la ${order.currentDraftVersion}) ipo tayari kuangaliwa!\n` +
    `Tafadhali ingia hapa kuona kurasa zote za jarida na kutoa idhini au maoni: ${trackingUrl}`;

  return sendNotification({
    to: order.clientWhatsApp,
    channel: 'whatsapp',
    template: 'draft_released',
    message,
    orderId: order._id,
  });
};

export const notifyPrinterDispatch = async (order, printerPhone, printUrl, specs) => {
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

export const notifyPrintingInProgress = async (order) => {
  const message =
    `Habari ${order.clientName}! Jarida lako limeanza kuchapwa rasmi kwenye mashine za uchapaji.\n` +
    `Tutakutaarifu pindi litakapokuwa tayari kusafirishwa.`;

  return sendNotification({
    to: order.clientWhatsApp,
    channel: 'whatsapp',
    template: 'printing_in_progress',
    message,
    orderId: order._id,
  });
};

export const notifyDispatchRecorded = async (order, trackingRef, carrier) => {
  const message =
    `Habari ${order.clientName}! Jarida lako limekamilika na limesafirishwa!\n` +
    `Msafirishaji: ${carrier || 'Usafiri Maalum'}\n` +
    `Kumbukumbu ya Mzigo: ${trackingRef || 'Inakuja'}\n` +
    `Asante kwa kuchagua Tinzel!`;

  return sendNotification({
    to: order.clientWhatsApp,
    channel: 'whatsapp',
    template: 'order_dispatched',
    message,
    orderId: order._id,
  });
};
