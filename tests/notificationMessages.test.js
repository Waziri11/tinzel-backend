import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { notificationFrontendUrl, notificationBackendUrl, notificationTrackingUrl } from '../src/services/notificationUrls.js';
import { staffCredentialMessage, clientOtpMessage } from '../src/services/accountMessages.js';
import { workflowMessage } from '../src/services/workflowMessages.js';

test('customer journey messages explain the next step and preserve staff instructions', () => {
  const order = { trackingId: 'TNZ-TEST', clientName: 'Test customer', formTitle: 'Birthday Magazine' };
  for (const lang of ['en', 'sw']) for (const type of ['order_submitted', 'payment_verified', 'draft_released', 'printing_in_progress', 'order_dispatched', 'order_closed']) {
    const message = workflowMessage(type, order, { version: 2 }, { role: 'client', channel: 'email' }, lang, 'https://tinzel.gifts/track');
    assert.doesNotMatch(message.message, /assigned|manager|approval loop|upload the print|meneja|kupangiwa/i);
    assert.match(message.html, lang === 'en' ? /Track my order/ : /Fuatilia oda yangu/);
    assert.match(message.message, /TNZ-TEST/);
  }
  const review = workflowMessage('draft_released', order, { version: 2 }, { role: 'client' }, 'en', '');
  assert.match(review.message, /check every page/);
  assert.match(review.message, /Approve it for printing/);
  const staff = workflowMessage('client_approved', order, { version: 2 }, { role: 'designer' }, 'en', '');
  assert.match(staff.message, /Upload the print file/);
});

const saved = Object.fromEntries(['FRONTEND_URL','BACKEND_URL','NODE_ENV','VERCEL'].map(key => [key,process.env[key]]));
afterEach(() => { for (const [key,value] of Object.entries(saved)) { if(value === undefined) delete process.env[key]; else process.env[key] = value; } });

test('outbound customer and staff links use public HTTPS even with stale local hosting configuration', () => {
  for (const value of [undefined, '', 'http://localhost:5173', 'https://127.0.0.1:5173', 'https://app.localhost', 'javascript:alert(1)', 'https://user:secret@example.test']) {
    if(value === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL=value;
    assert.equal(notificationFrontendUrl(),'https://tinzel.stryxis.com');
  }
  process.env.FRONTEND_URL='https://tinzel.stryxis.com/';
  assert.equal(notificationTrackingUrl('http://localhost:5173/track'),'https://tinzel.stryxis.com/track');
  assert.equal(notificationFrontendUrl(),'https://tinzel.stryxis.com');
  process.env.FRONTEND_URL='https://preview.example.test';
  assert.equal(notificationFrontendUrl(),'https://preview.example.test');
});

test('production protected printer links cannot use a loopback request origin', () => {
  process.env.NODE_ENV='production';delete process.env.VERCEL;process.env.BACKEND_URL='http://localhost:5001';
  assert.equal(notificationBackendUrl('http://127.0.0.1:8888'),'https://tinzel-backend.stryxis.com');
  process.env.NODE_ENV='test';
  assert.equal(notificationBackendUrl('http://127.0.0.1:8888'),'http://127.0.0.1:8888');
  process.env.VERCEL='1';
  assert.equal(notificationBackendUrl('http://127.0.0.1:8888'),'https://tinzel-backend.stryxis.com');
});

test('created and reissued credentials contain only the sign-in essentials in both languages', () => {
  process.env.FRONTEND_URL='http://localhost:5173';
  for(const preferredLanguage of ['en','sw'])for(const role of ['admin','manager','designer'])for(const reason of ['created','reissue']) {
    const user={name:'Asha',email:'asha@example.test',role,preferredLanguage,temporaryPasswordExpiresAt:new Date('2026-11-02T09:00:00Z'),credentialGeneration:1,credentialJob:{reason}};
    const content=staffCredentialMessage(user,'Example<&7','email');
    for(const value of [user.email,'Example<&7','https://tinzel.stryxis.com/staff','EAT'])assert.ok(content.message.includes(value));
    assert.doesNotMatch(content.message,/Responsibilities|Role:|Majukumu|Wadhifa/);
    assert.match(content.message,preferredLanguage==='en'?/set your password/:/weka nenosiri lako/);
    if(reason==='reissue')assert.match(content.title,preferredLanguage==='en'?/New Tinzel password/:/Nenosiri jipya/);
    assert.ok(!content.html.includes('Example<&7'));assert.ok(content.html.includes('Example&lt;&amp;7'));assert.doesNotMatch(content.message,/localhost/);
  }
});

test('handoff messages identify the customer and order and distinguish designer actions from manager updates', () => {
  const order={submissionId:'SUB-99',trackingId:'TNZ-99',clientName:'Neema',formTitle:'Birthday Magazine',revisionRequests:[{_id:'round-2',roundNumber:2,items:[{},{}]}]};
  const event={version:3,revisionId:'round-2'};
  for(const lang of ['en','sw'])for(const type of ['client_revision_requested','client_approved','printing_in_progress','order_closed']) {
    const content=workflowMessage(type,order,event,{name:'Manager A',role:'manager',channel:'sms'},lang,'https://tinzel.stryxis.com/staff/post-design');
    for(const value of ['Neema','TNZ-99','Birthday Magazine']) assert.ok(content.message.includes(value));
    assert.doesNotMatch(content.message,/Manager A|SUB-99|Role:|Wadhifa:|Responsibilities|Majukumu/);
    if(type==='client_approved') assert.match(content.message,lang==='en'?/customer approved version 3/:/Mteja ameidhinisha toleo la 3/);
  }
  const designer=workflowMessage('client_approved',order,event,{name:'Designer A',role:'designer'},'en','https://tinzel.stryxis.com/staff/design/orders/99');
  assert.match(designer.message,/Upload the print file/);
});

test('printer SMS directs to WhatsApp, while WhatsApp includes specifications and the protected link', () => {
  const order={submissionId:'SUB-99',trackingId:'TNZ-99',clientName:'Neema',printDocument:{specs:{quantity:3,paperType:'Glossy',coverFinish:'Matte',binding:'Saddle Stitch'}}};
  const event={version:3},recipient={name:'Printing Partner',role:'printer'};
  const sms=workflowMessage('print_dispatched',order,event,{...recipient,channel:'sms'},'en','');
  assert.match(sms.message,/Open WhatsApp and reply POKEA TNZ-99/);assert.doesNotMatch(sms.message,/\/api\/print-jobs\//);
  const wa=workflowMessage('print_dispatched',order,event,{...recipient,channel:'whatsapp'},'en','https://tinzel-backend.stryxis.com/api/print-jobs/protected');
  assert.match(wa.message,/Copies: 3\nPaper: Glossy\nCover: Matte\nBinding: Saddle Stitch/);assert.match(wa.message,/Approved version: 3/);assert.ok(wa.message.includes('/api/print-jobs/protected'));
});

test('customer OTP messages use the saved language and give the order, public sign-in link, expiry and secrecy instruction', () => {
  for(const clientPreferredLanguage of ['en','sw']) {
    const content=clientOtpMessage({clientName:'Neema',trackingId:'TNZ-99',clientPreferredLanguage},'123456');
    for(const value of ['TNZ-99','123456','10','https://tinzel.stryxis.com/track'])assert.ok(content.message.includes(value));
    assert.match(content.message,clientPreferredLanguage==='en'?/Do not share it/:/Usiushirikishe/);
  }
});

test('payment confirmation includes the saved amount and receipt reference without inventing missing payment details', () => {
 const order={submissionId:'SUB-99',trackingId:'TNZ-99',clientName:'Neema',paymentDetails:{amountPaid:50000,lipaNambaReference:'PAY-123'}};
 for(const lang of ['en','sw']) {
  const content=workflowMessage('payment_verified',order,{}, {name:'Neema',role:'client'},lang,'https://tinzel.stryxis.com/track');
  assert.match(content.message,/50,000/);assert.match(content.message,/PAY-123/);assert.match(content.message,/TZS/);
 }
 delete order.paymentDetails;
 assert.doesNotMatch(workflowMessage('payment_verified',order,{}, {name:'Neema',role:'client'},'en','').message,/Verified amount|Payment reference/);
});

test('all workflow channels omit submission references before a tracking ID is assigned', () => {
  const order = { submissionId: 'SUB-2026-6AEF293E66CFE393BBD48910', clientName: 'Christine Christoph', formTitle: 'Birthday Magazine' };
  const types = ['order_submitted', 'payment_verified', 'assignment_queued', 'order_assigned', 'draft_uploaded', 'draft_released', 'draft_returned', 'client_revision_requested', 'client_approved', 'print_document_uploaded', 'print_dispatched', 'printing_in_progress', 'printing_completed', 'order_dispatched', 'order_closed'];
  for (const type of types) for (const role of ['client', 'manager', 'admin', 'designer', 'printer']) for (const channel of ['sms', 'email', 'whatsapp', 'in_system']) for (const lang of ['en', 'sw']) {
    const content = workflowMessage(type, order, {}, { role, channel }, lang, 'https://tinzel.gifts/staff/pre-design?orderId=example');
    assert.doesNotMatch(JSON.stringify(content), /SUB-|undefined/);
    if (channel !== 'in_system') assert.match(content.message, /orderId=example/);
  }
  for (const clientPreferredLanguage of ['en', 'sw']) {
    assert.doesNotMatch(JSON.stringify(clientOtpMessage({ ...order, clientPreferredLanguage }, '123456')), /SUB-|undefined/);
  }
});

test('legacy submission email subjects and bodies identify the customer without submission references', async () => {
  const { emailTemplates } = await import('../src/services/emailService.js');
  for (const isStaff of [true, false]) {
    const content = emailTemplates.order_submitted({ submissionId: 'SUB-2026-ABC123', clientName: 'Christine Christoph', formTitle: 'Birthday Magazine', isStaff });
    assert.doesNotMatch(JSON.stringify(content), /SUB-|Submission ID|Namba ya Mawasilisho/);
    assert.match(content.text, /Christine Christoph/);
    assert.match(content.text, /Birthday Magazine/);
  }
});
