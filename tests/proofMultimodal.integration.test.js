import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app.js';
import { Order } from '../src/models/Order.model.js';
import { ProofAttachment } from '../src/models/ProofAttachment.model.js';
import { MagazineForm } from '../src/models/MagazineForm.model.js';
import { StaffUser } from '../src/models/StaffUser.model.js';
import { ProofPage, MediaJob } from '../src/models/Media.model.js';
import { generateToken, generateClientToken } from '../src/middlewares/auth.middleware.js';
import { updateNotificationSettings } from '../src/services/notificationService.js';
import { cleanProofAttachments, claimAttachments, releaseAttachmentClaims } from '../src/services/proofAttachmentService.js';
import { submitAnnotations } from '../src/services/proofReaderService.js';
import { runProofJobs } from '../src/services/proofWorkerService.js';
import { createCanvas } from '@napi-rs/canvas';
import { keepLatestDraft } from '../src/services/draftReplacementPolicy.js';
let mongo, server, base, form, image, tokens = {}, users = {};
before(async () => {
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await ProofAttachment.init();
  await updateNotificationSettings({ channels: { sms: false, email: false, in_system: false } });
  for (const role of ['manager', 'admin', 'designer']) {
    users[role] = await StaffUser.create({ name: `Image ${role}`, email: `image-${role}@example.test`, role, passwordHash: 'unused', isActive: true });
    tokens[role] = await generateToken(users[role], { verifiedAt: new Date() });
  }
  const unassigned = await StaffUser.create({ name: 'Other designer', email: 'other-comment-audio@example.test', role: 'designer', passwordHash: 'unused', isActive: true });
  tokens.unassigned = await generateToken(unassigned, { verifiedAt: new Date() });
  form = await MagazineForm.create({ title: 'Image reviews', slug: 'image-review-tests', price: 100 });
  image = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#e8a459' } }).png().toBuffer();
  server = app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.closeAllConnections(); await new Promise(r => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });
async function fixture(client = false) {
  const id = randomUUID();
  const order = await Order.create({ submissionId: id, trackingId: id, formId: form._id, clientName: 'Review client', clientWhatsApp: '0712345678', assignedDesigner: users.designer._id,
    status: client ? 'client_review' : 'draft_manager_review', currentDraftVersion: 1, draftVersions: [{ versionNumber: 1, managerReview: { status: client ? 'approved' : 'pending' } }] });
  await ProofPage.create({ orderId: order._id, version: 1, page: 0, text: { pageCount: 1 } });
  const clientToken = await generateClientToken(order);
  const path = role => `/api/proofs/${role === 'client' ? 'client' : `staff/${order._id}`}/1`;
  const call = async (suffix, body, method = body === undefined ? 'GET' : 'POST', role = client ? 'client' : 'manager') => {
    const response = await fetch(base + path(role) + suffix, { method, headers: { Authorization: `Bearer ${role === 'client' ? clientToken : tokens[role]}`, 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    return { status: response.status, data: response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer()), headers: response.headers };
  };
  return { order, call, clientToken };
}
const target = { page: 1, kind: 'area', rects: [{ x: .1, y: .1, width: .2, height: .2 }], text: '', clientMutationId: randomUUID() };
async function attach(call, bytes = image, extra = {}) {
  const reserve = await call('/attachments', { clientId: randomUUID(), name: 'reference.png', size: bytes.length, contentType: 'image/png', ...extra });
  assert.equal(reserve.status, 200, JSON.stringify(reserve.data));
  for (let n = 0; n < Math.ceil(bytes.length / reserve.data.chunkBytes); n++) assert.equal((await call(`/attachments/${reserve.data.id}/chunks/${n}`, bytes.subarray(n * reserve.data.chunkBytes, (n + 1) * reserve.data.chunkBytes), 'PUT')).status, 200);
  const complete = await call(`/attachments/${reserve.data.id}/complete`, {});
  return { id: reserve.data.id, complete };
}
test('image-only manager comments persist, replay safely, reach designers, and survive historical cleanup', async () => {
  const { order, call } = await fixture();
  const { id, complete } = await attach(call); assert.equal(complete.status, 200, JSON.stringify(complete.data));
  const input = { ...target, attachmentIds: [id] };
  const saved = await call('/annotations', input); assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.annotations[0].attachments[0].id, id);
  assert.equal((await call('/annotations', input)).data.annotations.length, 1);
  assert.equal((await call('/annotations', { ...input, text: 'changed' })).status, 409);
  assert.equal((await call(`/attachments/${id}`, undefined, 'GET', 'designer')).status, 404);
  const owned = await call(`/attachments/${id}?thumbnail=1`); assert.equal(owned.status, 200); assert.match(owned.headers.get('cache-control'), /no-store/);
  const fresh = await Order.findById(order._id); const items = submitAnnotations(fresh, 'manager');
  assert.match(items[0].text, /Review attached images/); assert.equal(String(items[0].annotationId), saved.data.annotations[0]._id);
  fresh.revisionRequests.push({ roundNumber: 1, draftVersionNumber: 1, source: 'manager', requestedBy: { type: 'manager' }, items });
  fresh.currentDraftVersion = 2; fresh.draftVersions.push({ versionNumber: 2 }); await fresh.save();
  assert.equal((await call(`/attachments/${id}`, undefined, 'GET', 'designer')).status, 200);
  assert.equal((await call(`/annotations/${saved.data.annotations[0]._id}`, undefined, 'DELETE')).status, 403);
  await ProofAttachment.updateOne({ _id: id }, { $set: { expiresAt: new Date(0) } }); await cleanProofAttachments();
  assert.ok(await ProofAttachment.exists({ _id: id })); assert.equal((await call(`/attachments/${id}`)).status, 200);
});
test('client images inherit private and submitted visibility; another order cannot read or claim them', async () => {
  const { order, call } = await fixture(true), other = await fixture();
  const { id } = await attach(call);
  assert.equal((await other.call(`/attachments/${id}`)).status, 404);
  assert.equal((await other.call('/annotations', { ...target, attachmentIds: [id] })).status, 400);
  assert.equal((await call('/annotations', { ...target, attachmentIds: [id] })).status, 200);
  assert.equal((await call(`/attachments/${id}`, undefined, 'GET', 'manager')).status, 404);
  const record = await Order.findById(order._id); submitAnnotations(record, 'client'); await record.save();
  assert.equal((await call(`/attachments/${id}`, undefined, 'GET', 'designer')).status, 200);
});
test('chunk retries are immutable, incomplete uploads cannot save, and validation rejects invalid files and count limits', async () => {
  const { call } = await fixture();
  const body = { clientId: randomUUID(), name: 'photo.png', size: image.length, contentType: 'image/png' };
  const first = await call('/attachments', body), id = first.data.id;
  assert.equal((await call('/attachments', body)).data.id, id);
  assert.equal((await call(`/attachments/${id}/complete`, {})).status, 400);
  assert.equal((await call('/annotations', { ...target, attachmentIds: [id] })).status, 400);
  assert.equal((await call(`/attachments/${id}/chunks/0`, image, 'PUT')).status, 200);
  assert.equal((await call(`/attachments/${id}/chunks/0`, image, 'PUT')).status, 200);
  assert.equal((await call(`/attachments/${id}/chunks/0`, Buffer.alloc(image.length), 'PUT')).status, 409);
  assert.equal((await call('/attachments', body)).data.received.length, 1);
  assert.equal((await call(`/attachments/${id}/complete`, {})).status, 200);
  assert.equal((await call(`/attachments/${id}/complete`, {})).status, 200);
  assert.equal((await call('/annotations', { ...target, attachmentIds: [id, id] })).status, 400);
  assert.equal((await call('/annotations', { ...target, attachmentIds: Array.from({ length: 6 }, () => new mongoose.Types.ObjectId().toString()) })).status, 400);
  assert.equal((await call('/annotations', target)).status, 400);
  assert.equal((await call('/annotations', { ...target, text: 'a'.repeat(4001) })).status, 400);
  assert.equal((await call('/attachments', { ...body, clientId: randomUUID(), size: 10 * 1024 * 1024 + 1 })).status, 400);
  assert.equal((await call('/attachments', { ...body, contentType: 'image/svg+xml' })).status, 400);
  const bad = await attach(call, Buffer.from('<svg>Not a photo</svg>')); assert.equal(bad.complete.status, 400);
});
test('discarded and abandoned images are cleaned, and conflicting claims can be released', async () => {
  const { call, order } = await fixture(); const { id } = await attach(call);
  const claimId = new mongoose.Types.ObjectId();
  const req = { proofOrder: order, proofVersion: 1, proofSource: 'manager', user: users.manager };
  await claimAttachments(req, [id], claimId);
  await assert.rejects(claimAttachments(req, [id], new mongoose.Types.ObjectId()));
  await releaseAttachmentClaims(claimId);
  assert.equal((await ProofAttachment.findById(id)).state, 'ready');
  const saved = await call('/annotations', { ...target, attachmentIds: [id] }); assert.equal(saved.status, 200);
  assert.equal((await call(`/annotations/${saved.data.annotations[0]._id}`, undefined, 'DELETE')).status, 200);
  await cleanProofAttachments(); assert.equal(await ProofAttachment.exists({ _id: id }), null);
  const another = await attach(call); await call(`/attachments/${another.id}`, undefined, 'DELETE'); await cleanProofAttachments();
  assert.equal((await call(`/attachments/${another.id}`)).status, 404);
});
test('review images retain exact originals and serve a separate WebP thumbnail', async () => {
  const { call } = await fixture();
  for (const format of ['jpeg', 'png', 'webp']) {
    const bytes = await sharp({ create: { width: 320, height: 240, channels: 4, background: '#e8a45980' } })
      .withMetadata({ orientation: 6 })[format]().toBuffer();
    const { id, complete } = await attach(call, bytes, { name: `original.${format}`, contentType: `image/${format}` });
    assert.equal(complete.status, 200, JSON.stringify(complete.data));
    const original = await call(`/attachments/${id}`);
    assert.equal(original.headers.get('content-type'), `image/${format}`);
    assert.deepEqual(original.data, bytes);
    const thumbnail = await call(`/attachments/${id}?thumbnail=1`);
    assert.equal(thumbnail.headers.get('content-type'), 'image/webp');
    assert.equal((await sharp(thumbnail.data).metadata()).format, 'webp');
  }
});
test('real OCR job reads the clean page, stores English/Swahili positions, and is idempotent', async () => {
  const { order, call } = await fixture();
  const canvas = createCanvas(1200, 900), ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1200, 900); ctx.fillStyle = 'black'; ctx.font = '36px "Tinzel Watermark"';
  ['Magazine story in print', 'Karibu kwenye jarida letu', 'Our wonderful birthday memories', 'Habari za familia na marafiki'].forEach((line, i) => ctx.fillText(line, 80, 100 + i * 100));
  const storage = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'proofPages' }), stream = storage.openUploadStream('ocr.webp');
  await pipeline(Readable.from(await canvas.encode('webp')), stream);
  await ProofPage.create({ orderId: order._id, version: 1, page: 1, width: 1200, height: 900, imageId: stream.id, geometryVersion: 3, text: [], imageRegions: [] });
  assert.equal((await call('/prepare', { pages: [1], ocr: true })).status, 200);
  assert.equal((await call('/prepare', { pages: [1], ocr: true })).status, 200);
  assert.equal(await MediaJob.countDocuments({ orderId: order._id, ocrOnly: true }), 1);
  await runProofJobs({ filter: { orderId: order._id }, maxJobs: 1, budgetMs: 45000 });
  const result = await call('/pages/1?text=1'); assert.equal(result.data.ocrVersion, 1, JSON.stringify(await MediaJob.find({ orderId: order._id }).lean()));
  const words = result.data.text.map(t => t.str).join(' '); assert.match(words, /Magazine/); assert.match(words, /Karibu/);
  assert.ok(result.data.text.every(t => t.x >= 0 && t.y >= 0 && t.x + t.width <= 1 && t.y + t.height <= 1));
  assert.equal((await call('/')).data.pages[0].ocrState, 'ready');
  await call('/prepare', { pages: [1], ocr: true }); assert.equal(await MediaJob.countDocuments({ orderId: order._id, ocrOnly: true }), 1);
});

test('five images can accompany text, while forged types and oversized decoded images are rejected', async () => {
  const { call } = await fixture(); const ids = [];
  for (let n = 0; n < 5; n++) { const upload = await attach(call); assert.equal(upload.complete.status, 200); ids.push(upload.id); }
  const saved = await call('/annotations', { ...target, text: 'Use these five references', attachmentIds: ids });
  assert.equal(saved.status, 200); assert.equal(saved.data.annotations[0].attachments.length, 5);
  const forged = await attach(call, image, { contentType: 'image/jpeg' }); assert.equal(forged.complete.status, 400);
  const large = await sharp({ create: { width: 6500, height: 6200, channels: 3, background: 'white' } }).png().toBuffer();
  const oversized = await attach(call, large); assert.equal(oversized.complete.status, 400);
});

test('an interrupted multi-part image resumes from confirmed chunks', async () => {
  const { call } = await fixture();
  const { randomBytes } = await import('node:crypto');
  const bytes = await sharp(randomBytes(750 * 750 * 3), { raw: { width: 750, height: 750, channels: 3 } }).png().toBuffer();
  assert.ok(bytes.length > 1024 * 1024);
  const body = { clientId: randomUUID(), name: 'large.png', size: bytes.length, contentType: 'image/png' };
  const { data: session } = await call('/attachments', body);
  assert.equal((await call(`/attachments/${session.id}/chunks/0`, bytes.subarray(0, session.chunkBytes), 'PUT')).status, 200);
  assert.equal((await call(`/attachments/${session.id}/complete`, {})).status, 400);
  const resume = await call('/attachments', body); assert.deepEqual(resume.data.received.map(p => p.n), [0]);
  assert.equal((await call(`/attachments/${session.id}/chunks/1`, bytes.subarray(session.chunkBytes), 'PUT')).status, 200);
  assert.equal((await call(`/attachments/${session.id}/complete`, {})).status, 200);
});

const audio = Buffer.alloc(16044);
audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16);
audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28);
audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(16000, 40);
const audioInfo = { name: 'voice-note.wav', contentType: 'audio/wav' };

for (const source of ['manager', 'client']) test(`${source} audio-only comments reach returns and keep playing after the magazine is replaced`, async () => {
  const { order, call, clientToken } = await fixture(source === 'client');
  const { id } = await attach(call, audio, audioInfo);
  const saved = await call('/annotations', { ...target, clientMutationId: randomUUID(), attachmentIds: [id] });
  assert.equal(saved.status, 200);
  const response = await fetch(base + (source === 'client' ? '/api/client/request-revision' : `/api/manager/orders/${order._id}/review-draft`), {
    method: 'POST', headers: { Authorization: `Bearer ${source === 'client' ? clientToken : tokens.manager}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedVersion: 1, items: [], ...(source === 'manager' ? { action: 'return_to_designer', feedback: '' } : {}) }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  const read = (path, token = tokens.designer) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
  const payload = await (await read(`/api/designer/orders/${order._id}`)).json();
  const round = payload.order.revisionRequests[0], item = round.items[0];
  assert.equal(item.annotationId, saved.data.annotations[0]._id);
  assert.deepEqual(item.audio, { contentType: 'audio/wav' });
  const returns = await (await read('/api/designer/returns')).json();
  const row = returns.returns.find(row => row._id === round._id);
  assert.deepEqual(row.items[0].audio, { contentType: 'audio/wav' });
  assert.equal(row.proofAnnotations, undefined);
  const staffPath = `/api/designer/orders/${order._id}/revisions/${round._id}/items/${item._id}/audio`;
  const clientPath = `/api/client/revisions/${round._id}/items/${item._id}/audio`;
  const listen = async () => {
    const stream = await read(staffPath);
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get('content-type'), 'audio/wav');
    assert.match(stream.headers.get('cache-control'), /no-store/);
    assert.deepEqual(Buffer.from(await stream.arrayBuffer()), audio);
  };
  await listen();
  assert.equal((await read(staffPath, tokens.unassigned)).status, 403);
  assert.equal((await fetch(base + staffPath)).status, 401);
  assert.equal((await read(clientPath, (await fixture(true)).clientToken)).status, 404);
  assert.equal((await read(clientPath, clientToken)).status, source === 'client' ? 200 : 404);
  const persisted = await Order.findById(order._id);
  // Existing returns have only annotationId, not an audio copy on their checklist item.
  assert.equal(persisted.revisionRequests[0].items[0].audio, undefined);
  persisted.currentDraftVersion = 2;
  persisted.draftVersions.push({ versionNumber: 2 });
  keepLatestDraft(persisted);
  await persisted.save();
  await ProofAttachment.updateOne({ _id: id }, { $set: { expiresAt: new Date(0) } });
  await cleanProofAttachments();
  await listen();
  if (source === 'client') {
    const history = await (await read('/api/client/order', clientToken)).json();
    assert.deepEqual(history.order.revisionRequests[0].items[0].audio, { contentType: 'audio/wav' });
    const stream = await read(clientPath, clientToken);
    assert.equal(stream.status, 200);
    assert.deepEqual(Buffer.from(await stream.arrayBuffer()), audio);
  }
  // A return must never expose an unsubmitted comment, a different source, or another version.
  for (const change of [{ submittedAt: null }, { source: source === 'client' ? 'manager' : 'client' }, { version: 99 }]) {
    const fresh = await Order.findById(order._id);
    const annotation = fresh.proofAnnotations.id(item.annotationId);
    const original = { submittedAt: annotation.submittedAt, source: annotation.source, version: annotation.version };
    Object.assign(annotation, change); await fresh.save();
    assert.equal((await read(staffPath)).status, 404);
    const hidden = await (await read(`/api/designer/orders/${order._id}`)).json();
    assert.equal(hidden.order.revisionRequests[0].items[0].audio, undefined);
    Object.assign(annotation, original); await fresh.save();
  }
});

test('audio-only page comments save privately, submit as a required correction, and play for assigned staff', async () => {
  const { order, call, clientToken } = await fixture(true), other = await fixture(true);
  const { id, complete } = await attach(call, audio, audioInfo);
  assert.equal(complete.status, 200, JSON.stringify(complete.data));
  assert.equal(complete.data.contentType, 'audio/wav');
  const input = { ...target, clientMutationId: randomUUID(), attachmentIds: [id] };
  const saved = await call('/annotations', input);
  assert.equal(saved.status, 200); assert.equal(saved.data.annotations[0].attachments[0].contentType, 'audio/wav');
  assert.equal((await call('/annotations', input)).data.annotations.length, 1);
  const playback = await call(`/attachments/${id}`);
  assert.equal(playback.status, 200); assert.equal(playback.headers.get('content-type'), 'audio/wav');
  assert.match(playback.headers.get('cache-control'), /no-store/); assert.deepEqual(playback.data, audio);
  assert.equal((await other.call(`/attachments/${id}`)).status, 404);
  assert.equal((await call(`/attachments/${id}`, undefined, 'GET', 'designer')).status, 404);
  assert.equal((await call(`/attachments/${id}`, undefined, 'GET', 'manager')).status, 404);
  const submitted = await fetch(base + '/api/client/request-revision', { method: 'POST', headers: { Authorization: `Bearer ${clientToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1, items: [] }) });
  const body = await submitted.json(); assert.equal(submitted.status, 200, JSON.stringify(body));
  assert.equal(body.order.revisionRequests[0].items[0].status, 'open');
  assert.match(body.order.revisionRequests[0].items[0].text, /Listen to attached audio/);
  assert.equal(body.order.revisionRequests[0].items[0].annotationId, saved.data.annotations[0]._id);
  for (const role of ['manager', 'designer']) assert.deepEqual((await call(`/attachments/${id}`, undefined, 'GET', role)).data, audio);
  await ProofAttachment.updateOne({ _id: id }, { $set: { expiresAt: new Date(0) } }); await cleanProofAttachments();
  assert.ok(await ProofAttachment.exists({ _id: id }));
  assert.equal((await Order.findById(order._id)).proofAnnotations.length, 1);
});

test('audio accompanies five images, but multiple audio messages and spoofed or oversized uploads are rejected', async () => {
  const { call } = await fixture(); const ids = [];
  for (let n = 0; n < 5; n++) ids.push((await attach(call)).id);
  const sound = await attach(call, audio, audioInfo); ids.push(sound.id);
  assert.equal((await call('/annotations', { ...target, attachmentIds: ids })).status, 200);
  const one = await attach(call, audio, audioInfo), two = await attach(call, audio, audioInfo);
  assert.equal((await call('/annotations', { ...target, clientMutationId: randomUUID(), attachmentIds: [one.id, two.id] })).status, 400);
  assert.equal((await ProofAttachment.findById(one.id)).state, 'ready');
  assert.equal((await ProofAttachment.findById(two.id)).state, 'ready');
  assert.equal((await call('/attachments', { clientId: randomUUID(), ...audioInfo, size: 3 * 1024 * 1024 + 1 })).status, 400);
  assert.equal((await attach(call, image, audioInfo)).complete.status, 400);
  assert.equal((await attach(call, audio, { ...audioInfo, name: 'script.html' })).complete.status, 400);
});

test('discarded audio comments release their private audio bytes', async () => {
  const { call } = await fixture(true);
  const { id } = await attach(call, audio, audioInfo);
  const asset = await ProofAttachment.findById(id);
  const saved = await call('/annotations', { ...target, attachmentIds: [id] });
  assert.equal((await call(`/annotations/${saved.data.annotations[0]._id}`, undefined, 'DELETE')).status, 200);
  await cleanProofAttachments();
  assert.equal(await ProofAttachment.exists({ _id: id }), null);
  assert.equal(await mongoose.connection.db.collection('proofAttachments.files').countDocuments({ _id: asset.imageId }), 0);
  assert.equal((await call(`/attachments/${id}`)).status, 404);
});
