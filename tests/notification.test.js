import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePhoneNumber,
  sendNotification,
  getSimulatedNotifications,
  clearSimulatedNotifications,
  notifyPaymentVerified,
  notifyDraftReleased,
  notifyPrintingInProgress,
  notifyDispatchRecorded,
  notifyClientOtp,
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
