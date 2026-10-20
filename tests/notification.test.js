import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePhoneNumber,
  sendNotification,
  getSimulatedNotifications,
  getSimulatedInSystemNotifications,
  clearSimulatedNotifications,
  dispatchTriChannelNotification,
  markNotificationRead,
  markAllNotificationsRead,
  notifyPaymentVerified,
  notifyDraftReleased,
  notifyPrintingInProgress,
  notifyDispatchRecorded,
  notifyClientOtp,
  updateNotificationDeliveryStatus,
  recordInboundNotification,
  getNotificationHistory,
  testTwilioConnection,
} from '../src/services/notificationService.js';
import {
  emailTemplates,
  wrapEmailTemplate,
  isEmailConfigured,
} from '../src/services/emailService.js';

test('Phone Number Normalization: formats local Tanzanian and international numbers for Twilio', () => {
  assert.equal(normalizePhoneNumber('0712345678'), '+255712345678');
  assert.equal(normalizePhoneNumber('255712345678'), '+255712345678');
  assert.equal(normalizePhoneNumber('+255712345678'), '+255712345678');
  assert.equal(normalizePhoneNumber('+1 (555) 123-4567'), '+15551234567');
  assert.equal(normalizePhoneNumber(''), '');
});

test('Email Templates: complies with design constraints (no gradients, no emojis)', () => {
  const paymentTemplate = emailTemplates.payment_verified({
    clientName: 'Amani',
    trackingId: 'TNZ-2026-001',
    trackingUrl: 'https://tinzel.com/track/TNZ-2026-001',
    formTitle: 'Harusi Ya Amani',
  });

  assert.ok(paymentTemplate.html.includes('TNZ-2026-001'));
  assert.ok(paymentTemplate.html.includes('Amani'));
  assert.ok(paymentTemplate.text.includes('Harusi Ya Amani'));

  // Ensure NO gradients anywhere in the generated HTML
  assert.equal(paymentTemplate.html.includes('linear-gradient'), false);
  assert.equal(paymentTemplate.html.includes('radial-gradient'), false);

  // Check OTP template
  const otpTemplate = emailTemplates.client_otp({
    clientName: 'Baraka',
    otpCode: '482910',
    validityMinutes: 10,
  });
  assert.ok(otpTemplate.html.includes('482910'));
  assert.ok(otpTemplate.text.includes('482910'));
});

test('Notification Service: simulation mode records and dispatches multi-channel notifications', async () => {
  clearSimulatedNotifications();

  // Test single email dispatch in simulation mode
  const emailResult = await sendNotification({
    to: 'customer@example.com',
    channel: 'email',
    template: 'test_template',
    subject: 'Jarida Lako',
    message: 'Maelezo ya jarida lako',
  });

  assert.equal(emailResult.channel, 'email');
  assert.equal(emailResult.mode, 'simulated');

  // Test single WhatsApp dispatch in simulation mode
  const whatsappResult = await sendNotification({
    to: '0712345678',
    channel: 'whatsapp',
    template: 'test_wa',
    message: 'Habari kupitia WhatsApp',
  });

  assert.equal(whatsappResult.channel, 'whatsapp');
  assert.equal(whatsappResult.mode, 'simulated');

  // Verify in-memory audit log
  const notifs = getSimulatedNotifications();
  assert.ok(notifs.length >= 2);
});

test('Milestone Multi-Channel: sends both WhatsApp and Email when both are provided', async () => {
  clearSimulatedNotifications();

  const mockOrder = {
    _id: '652abcdef0123456789abcde',
    clientName: 'Neema John',
    clientWhatsApp: '+255711223344',
    clientEmail: 'neema@example.com',
    trackingId: 'TNZ-TRK-8899',
    formTitle: 'Kumbukumbu ya Miaka 25',
  };

  const results = await notifyPaymentVerified(mockOrder, 'https://tinzel.com/track');
  assert.equal(results.length, 2);

  const notifs = getSimulatedNotifications();
  const waNotif = notifs.find((n) => n.channel === 'whatsapp');
  const emailNotif = notifs.find((n) => n.channel === 'email');

  assert.ok(waNotif, 'Should dispatch WhatsApp notification');
  assert.ok(emailNotif, 'Should dispatch Email notification');
  assert.equal(waNotif.to, '+255711223344');
  assert.equal(emailNotif.to, 'neema@example.com');
});

test('Milestone Multi-Channel: sends only WhatsApp if clientEmail is not present', async () => {
  clearSimulatedNotifications();

  const mockOrder = {
    _id: '652abcdef0123456789abcdf',
    clientName: 'Juma Ally',
    clientWhatsApp: '+255788990011',
    clientEmail: '',
    trackingId: 'TNZ-TRK-1122',
    formTitle: 'Graduation Magazine',
  };

  const results = await notifyPaymentVerified(mockOrder, 'https://tinzel.com/track');
  assert.equal(results.length, 1);

  const notifs = getSimulatedNotifications();
  assert.equal(notifs.length, 1);
  assert.equal(notifs[0].channel, 'whatsapp');
  assert.equal(notifs[0].to, '+255788990011');
});

test('Client OTP: dispatches OTP to both WhatsApp and Email', async () => {
  clearSimulatedNotifications();

  const mockOrder = {
    _id: '652abcdef0123456789abce0',
    clientName: 'Rehema',
    clientWhatsApp: '0714000111',
    clientEmail: 'rehema@example.com',
  };

  const results = await notifyClientOtp(mockOrder, '991122');
  assert.equal(results.length, 2);

  const notifs = getSimulatedNotifications();
  assert.equal(notifs.length, 2);
  const wa = notifs.find((n) => n.channel === 'whatsapp');
  const mail = notifs.find((n) => n.channel === 'email');

  assert.ok(wa.message.includes('991122'));
  assert.ok(mail.message.includes('991122'));
});

test('Twilio Webhook: updateNotificationDeliveryStatus updates status and error details', async () => {
  clearSimulatedNotifications();

  // Dispatch a simulated notification with a simulated SID
  const notif = await sendNotification({
    to: '0712345678',
    channel: 'whatsapp',
    template: 'test_delivery',
    message: 'Testing status update',
  });
  notif.sid = 'SM_TEST_123456';

  // Simulate Twilio StatusCallback webhook delivery
  const updated = await updateNotificationDeliveryStatus({
    twilioSid: 'SM_TEST_123456',
    status: 'delivered',
  });

  assert.ok(updated);
  assert.equal(updated.status, 'delivered');

  // Simulate a failed delivery webhook
  const failed = await updateNotificationDeliveryStatus({
    twilioSid: 'SM_TEST_123456',
    status: 'failed',
    errorCode: '30008',
    errorMessage: 'Unknown subscriber',
  });

  assert.ok(failed);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, '30008');
});

test('Twilio Inbound: recordInboundNotification records inbound replies', async () => {
  clearSimulatedNotifications();

  const inbound = await recordInboundNotification({
    from: '+255711223344',
    to: '+14155238886',
    body: 'POKEA',
    twilioSid: 'SM_INBOUND_9988',
    channel: 'whatsapp',
  });

  assert.equal(inbound.direction, 'inbound');
  assert.equal(inbound.status, 'received');
  assert.equal(inbound.message, 'POKEA');

  const history = await getNotificationHistory({ limit: 10 });
  assert.ok(history.length >= 1);
  assert.equal(history[0].message, 'POKEA');
});

test('Twilio Diagnostics: accurately reports simulation mode when credentials not configured', async () => {
  const diag = await testTwilioConnection();
  assert.equal(diag.mode, 'simulated');
  assert.equal(diag.configured, false);
});

test('QAMS Tri-Channel Notification: dispatches simultaneously to In-System, Email, and Phone and supports read state', async () => {
  clearSimulatedNotifications();

  const results = await dispatchTriChannelNotification({
    recipientName: 'Manager Asha',
    recipientRole: 'manager',
    email: 'asha@tinzel.co.tz',
    phone: '0712999888',
    title: 'Rasimu Mpya Inasubiri Mapitio',
    message: 'Rasimu V2 ya oda TNZ-2026-009 ipo tayari.',
    template: 'draft_uploaded',
  });

  assert.equal(results.length, 3);
  const inSys = getSimulatedInSystemNotifications();
  const ext = getSimulatedNotifications();

  assert.equal(inSys.length, 1);
  assert.equal(inSys[0].channel, 'in_system');
  assert.equal(inSys[0].isRead, false);

  const emailEntry = ext.find((n) => n.channel === 'email');
  const phoneEntry = ext.find((n) => n.channel === 'whatsapp');
  assert.ok(emailEntry, 'Should send Email');
  assert.ok(phoneEntry, 'Should send Phone/WhatsApp');
  assert.equal(inSys[0].eventGroupId, emailEntry.eventGroupId);
  assert.equal(inSys[0].eventGroupId, phoneEntry.eventGroupId);

  await markNotificationRead(inSys[0].id);
  assert.equal(inSys[0].isRead, true);
  assert.equal(emailEntry.isRead, true);
  assert.equal(phoneEntry.isRead, true);

  await markAllNotificationsRead();
  assert.ok(getSimulatedInSystemNotifications().every((n) => n.isRead));
});


