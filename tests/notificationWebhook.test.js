import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app.js';
import { Order } from '../src/models/Order.model.js';
import { MagazineForm } from '../src/models/MagazineForm.model.js';
import { SystemConfig } from '../src/models/SystemConfig.model.js';
import { AuditLog } from '../src/models/AuditLog.model.js';
import { Notification } from '../src/models/Notification.model.js';
import { StaffUser } from '../src/models/StaffUser.model.js';
import { generateToken } from '../src/middlewares/auth.middleware.js';

let mongo, server, baseUrl, adminToken;

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([
    Order.init(),
    MagazineForm.init(),
    SystemConfig.init(),
    AuditLog.init(),
    Notification.init(),
    StaffUser.init(),
  ]);

  const admin = await StaffUser.create({
    name: 'Notification Admin',
    email: 'admin@tinzel.com',
    passwordHash: '$2a$10$abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklm',
    role: 'admin',
    isActive: true,
  });
  adminToken = generateToken(admin);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}/api/notifications`;
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => server?.close(resolve));
  await mongoose.disconnect();
  await mongo?.stop();
});


test('Twilio Status Callback: updates notification status to delivered in MongoDB', async () => {
  const notif = await Notification.create({
    recipient: '+255712345678',
    channel: 'whatsapp',
    message: 'Hali ya oda yako',
    twilioSid: 'SM_TEST_STATUS_CALLBACK',
    status: 'sent',
    mode: 'twilio_live',
  });

  const response = await fetch(`${baseUrl}/webhooks/twilio-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      MessageSid: 'SM_TEST_STATUS_CALLBACK',
      MessageStatus: 'delivered',
    }),
  });

  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(text.includes('<Response/>'));

  const updated = await Notification.findById(notif._id);
  assert.equal(updated.status, 'delivered');
});

test('Twilio Inbound Webhook: printer replies "POKEA" to advance order to printing_in_progress', async () => {
  const printerPhone = '+255711223344';
  await SystemConfig.findOneAndUpdate(
    { key: 'printer_whatsapp_phone' },
    { key: 'printer_whatsapp_phone', value: printerPhone },
    { upsert: true }
  );

  const form = await MagazineForm.create({
    title: 'Print Webhook Form',
    slug: 'print-webhook-form',
    price: 35000,
  });

  const order = await Order.create({
    submissionId: 'SUB-2026-99999',
    trackingId: 'TNZ-TRK-9999',
    formId: form._id,
    formTitle: 'Kumbukumbu ya Harusi',
    clientName: 'Upendo Baraka',
    clientWhatsApp: '+255788112233',
    status: 'printing_sent',
  });

  const response = await fetch(`${baseUrl}/webhooks/twilio-inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      From: `whatsapp:${printerPhone}`,
      To: 'whatsapp:+14155238886',
      Body: 'POKEA',
      MessageSid: 'SM_INBOUND_PRINTER_POKEA',
    }),
  });

  assert.equal(response.status, 200);
  const twiml = await response.text();
  assert.ok(twiml.includes('imethibitishwa kuwa inachapwa sasa'));

  const refreshedOrder = await Order.findById(order._id);
  assert.equal(refreshedOrder.status, 'printing_in_progress');

  const audit = await AuditLog.findOne({
    orderId: order._id,
    action: 'PRINTER_CONFIRMED_POKEA',
  });
  assert.ok(audit, 'Audit log for printer confirmation must exist');

  const inboundNotif = await Notification.findOne({
    twilioSid: 'SM_INBOUND_PRINTER_POKEA',
  });
  assert.ok(inboundNotif);
  assert.equal(inboundNotif.direction, 'inbound');
  assert.equal(inboundNotif.status, 'received');
});

test('Twilio Inbound Webhook: deduplicates duplicate MessageSid', async () => {
  const printerPhone = '+255711223344';
  const response = await fetch(`${baseUrl}/webhooks/twilio-inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      From: `whatsapp:${printerPhone}`,
      To: 'whatsapp:+14155238886',
      Body: 'POKEA',
      MessageSid: 'SM_INBOUND_PRINTER_POKEA',
    }),
  });

  assert.equal(response.status, 200);
  const twiml = await response.text();
  assert.equal(twiml, '<Response></Response>');
});

test('Twilio Diagnostics API: returns diagnostics for authenticated managers', async () => {
  const response = await fetch(`${baseUrl}/diagnostics`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.success, true);
  assert.ok(json.diagnostics);
  assert.equal(json.diagnostics.mode, 'simulated');
});

test('Notification History API: fetches persistent records from MongoDB', async () => {
  const response = await fetch(`${baseUrl}/history?limit=10`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.success, true);
  assert.ok(Array.isArray(json.notifications));
  assert.ok(json.notifications.length > 0);
});
