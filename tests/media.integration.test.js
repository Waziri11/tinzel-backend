import {signMediaPath} from '../src/services/mediaSignService.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app.js';
import { MagazineForm } from '../src/models/MagazineForm.model.js';
import { Order } from '../src/models/Order.model.js';
import { AuditLog } from '../src/models/AuditLog.model.js';
import { UploadSession, MediaAsset } from '../src/models/Media.model.js';
import { CHUNK_BYTES } from '../src/services/mediaSessionService.js';
import sharp from 'sharp';
import { MediaJob } from '../src/models/Media.model.js';
import { StaffUser } from '../src/models/StaffUser.model.js';
import { generateToken, generateClientToken } from '../src/middlewares/auth.middleware.js';
import { runMediaJobs, enqueueArchive, cleanExpiredUploads, cleanDerivedMedia } from '../src/services/mediaJobService.js';

let mongo, server, base, form;
before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([Order.init(), UploadSession.init(), MediaAsset.init()]);
  form = await MagazineForm.create({ title: 'Media Test', slug: 'media-test', isActive: true, price: 50000,
    fields: [{ fieldId: 'photos', type: 'photo_group', label: 'Birthday photos', validationRules: { maxPhotos: 100 } }] });
  server = app.listen(0); await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/public/media`;
});
after(async () => { await new Promise((r) => server?.close(r)); await mongoose.disconnect(); await mongo?.stop(); });

async function request(path, session, body, method = body === undefined ? 'GET' : 'POST', binary = false) {
  const response = await fetch(base + path, { method, headers: { 'X-Upload-Token': session.token,
    ...(body !== undefined ? { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' } : {}) },
    body: body === undefined ? undefined : binary ? body : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
async function session() {
  const s = { id: randomUUID(), token: randomBytes(32).toString('hex') };
  assert.equal((await request('/sessions', s, { id: s.id, slug: form.slug })).status, 201);
  return s;
}
async function reserve(s, size, clientId = randomUUID()) {
  const response = await request(`/sessions/${s.id}/assets`, s, { clientId, size, name: 'original.jpg', contentType: 'image/jpeg', fieldId: 'photos' });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data.entry;
}

test('large originals resume in parts, reject changed parts, retain exact bytes and finalize once', async () => {
  const s = await session();
  const bytes = randomBytes(5 * CHUNK_BYTES + 71);
  const entry = await reserve(s, bytes.length);
  const path = `/sessions/${s.id}/assets/${entry._id}`;
  const part = bytes.subarray(0, CHUNK_BYTES);
  assert.equal((await request(`${path}/chunks/0`, s, part, 'PUT', true)).status, 200);
  assert.equal((await request(`${path}/chunks/0`, s, part, 'PUT', true)).status, 200);
  assert.equal((await request(`${path}/chunks/0`, s, Buffer.alloc(CHUNK_BYTES), 'PUT', true)).status, 409);
  const resumed = await request(path, s);
  assert.equal(resumed.data.chunks.length, 1);
  assert.equal((await request(`${path}/complete`, s, {})).status, 409);
  for (let n = 1; n < Math.ceil(bytes.length / CHUNK_BYTES); n++) assert.equal((await request(`${path}/chunks/${n}`, s, bytes.subarray(n * CHUNK_BYTES, (n + 1) * CHUNK_BYTES), 'PUT', true)).status, 200);
  const completed = await request(`${path}/complete`, s, {});
  assert.equal(completed.status, 200, JSON.stringify(completed.data));
  assert.deepEqual((await request(`${path}/complete`, s, {})).data.photo, completed.data.photo);
  const downloaded = await fetch(base + signMediaPath(`/api/public/media/assets/${entry._id}`).replace('/api/public/media', ''));
  assert.equal(downloaded.status,404); // Unsubmitted originals have no authorized order owner.
  const body = { clientName: 'Test Client', clientWhatsApp: '0712345678', answers: {}, assetIds: [entry._id] };
  const results = await Promise.all([request(`/sessions/${s.id}/submit`, s, body), request(`/sessions/${s.id}/submit`, s, body)]);
  assert.equal(results[0].status, 201, JSON.stringify(results));
  assert.equal(results[1].status, 201, JSON.stringify(results));
  assert.equal(results[0].data.order.submissionId, results[1].data.order.submissionId);
  assert.equal(await Order.countDocuments({ mediaSessionId: s.id }), 1);
  const order = await Order.findOne({ mediaSessionId: s.id });
  assert.equal(await AuditLog.countDocuments({ orderId: order._id, action: 'ORDER_SUBMITTED' }), 1);
  assert.equal(order.uploadedPhotos[0].folderName, 'Birthday photos');
  const retrieved=await fetch(base+`/assets/${entry._id}`,{headers:{Cookie:`tinzel_client=${await generateClientToken(order)}`}});assert.equal(retrieved.status,200);assert.deepEqual(Buffer.from(await retrieved.arrayBuffer()),bytes);
});

test('cancelled selections cannot be resurrected by a late reservation', async () => {
  const s = await session(); const clientId = randomUUID();
  assert.equal((await request(`/sessions/${s.id}/selections/${clientId}`, s, undefined, 'DELETE')).status, 200);
  const response = await request(`/sessions/${s.id}/assets`, s, { clientId, size: 10, name: 'original.jpg', contentType: 'image/jpeg', fieldId: 'photos' });
  assert.equal(response.status, 409);
});

test('draft previews require the owning open upload session and stop after removal or submission', async () => {
  const owner = await session(), other = await session();
  const bytes = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#b99a54' } }).png().toBuffer();
  const entry = await reserve(owner, bytes.length);
  const path = `/sessions/${owner.id}/assets/${entry._id}`;
  assert.equal((await request(`${path}/preview`, owner)).status, 404);
  await request(`${path}/chunks/0`, owner, bytes, 'PUT', true);
  await request(`${path}/complete`, owner, {});
  const preview = await fetch(base + `${path}/preview`, { headers: { 'X-Upload-Token': owner.token } });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), bytes);
  assert.equal((await fetch(base + `${path}/preview`)).status, 404);
  assert.equal((await request(`${path}/preview`, other)).status, 404);
  assert.equal((await request(`/sessions/${other.id}/assets/${entry._id}/preview`, other)).status, 404);
  await request(`${path}`, owner, undefined, 'DELETE');
  assert.equal((await request(`${path}/preview`, owner)).status, 404);
  const second = await reserve(owner, bytes.length);
  const next = `/sessions/${owner.id}/assets/${second._id}`;
  await request(`${next}/chunks/0`, owner, bytes, 'PUT', true);
  await request(`${next}/complete`, owner, {});
  await request(`/sessions/${owner.id}/submit`, owner, { clientName: 'Preview Test', clientWhatsApp: '0712345678', answers: {}, assetIds: [second._id] });
  assert.equal((await request(`${next}/preview`, owner)).status, 409);
});

test('reservation limits and invalid sessions fail before bytes are transferred', async () => {
  const s = await session();
  const tooLarge = await request(`/sessions/${s.id}/assets`, s, { clientId: randomUUID(), name: 'x.jpg', size: 26 * 1024 * 1024, contentType: 'image/jpeg', fieldId: 'photos' });
  assert.equal(tooLarge.status, 413);
  assert.equal((await request(`/sessions/${s.id}`, { ...s, token: 'wrong' })).status, 404);
  const entry = await reserve(s, 2);
  assert.equal((await request(`/sessions/${s.id}/assets/${entry._id}/chunks/0`, s, Buffer.from('bad'), 'PUT', true)).status, 400);
});

test('durable worker generates a small preview and cached downloadable ZIP; cleanup retains submitted originals', async () => {
  const s = await session();
  const image = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#b58248' } }).jpeg().toBuffer();
  const entry = await reserve(s, image.length);
  const path = `/sessions/${s.id}/assets/${entry._id}`;
  assert.equal((await request(`${path}/chunks/0`, s, image, 'PUT', true)).status, 200);
  assert.equal((await request(`${path}/complete`, s, {})).status, 200);
  const submit = await request(`/sessions/${s.id}/submit`, s, { clientName: 'Preview Test', clientWhatsApp: '0712345678', answers: {}, assetIds: [entry._id] });
  assert.equal(submit.status, 201);
  const order = await Order.findOne({ mediaSessionId: s.id });
  const job = await enqueueArchive(order, 'Birthday photos');
  assert.equal((await enqueueArchive(order, 'Birthday photos'))._id, job._id);
  const workers = await Promise.all([runMediaJobs({ maxJobs: 10 }), runMediaJobs({ maxJobs: 10 })]);
  assert.ok(workers.some((r) => r.processed === 0));
  assert.equal((await MediaJob.findById(job._id)).state, 'ready');
  const preview = await fetch(base + `/assets/${entry._id}/thumbnail`,{headers:{Cookie:`tinzel_client=${await generateClientToken(order)}`}});
  assert.equal(preview.status, 200);
  const previewBytes = Buffer.from(await preview.arrayBuffer());
  const meta = await sharp(previewBytes).metadata();
  assert.ok(meta.width <= 480); assert.ok(previewBytes.length < 100000);
  assert.equal((await MediaAsset.findById(entry._id)).sha256.length, 64);
  const staff = await StaffUser.create({ name: 'Media Test Manager', email: 'media-test@example.test', passwordHash: 'not-a-login', role: 'manager', isActive: true });
  const response = await fetch(base.replace('/public/media', '') + `/designer/orders/${order._id}/photo-folder-download`, {
    method: 'POST', headers: { Authorization: `Bearer ${await generateToken(staff,{verifiedAt:new Date()})}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: 'Birthday photos' }),
  });
  assert.equal(response.status, 200);
  const { url } = await response.json();
  const download = await fetch(base.split('/api/')[0] + url,{headers:{Authorization:`Bearer ${await generateToken(staff,{verifiedAt:new Date()})}`}});
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /attachment/);
  const zip = Buffer.from(await download.arrayBuffer());
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.ok(zip.includes(image));
  await MediaJob.updateOne({ _id: job._id }, { $set: { completedAt: new Date(Date.now() - 2 * 86400000) } });
  await cleanDerivedMedia();
  assert.equal((await MediaJob.findById(job._id)).state, 'ready', 'recent download protects its archive');
  await MediaJob.updateOne({ _id: job._id }, { $set: { lastDownloadAt: new Date(0) } });
  await cleanDerivedMedia();
  assert.equal((await MediaJob.findById(job._id)).state, 'expired');
  assert.equal((await enqueueArchive(order, 'Birthday photos')).state, 'queued');
  assert.ok(await MediaAsset.findById(entry._id), 'archive eviction must not remove original photos');
  // Expiry cleanup must retain photos referenced by an order, but reclaim abandoned parts.
  const abandoned = await session(); const unused = await reserve(abandoned, 2);
  await request(`/sessions/${abandoned.id}/assets/${unused._id}/chunks/0`, abandoned, Buffer.from('ab'), 'PUT', true);
  await UploadSession.updateMany({ _id: { $in: [s.id, abandoned.id] } }, { $set: { expiresAt: new Date(Date.now() - 9 * 86400000) } });
  await cleanExpiredUploads();
  assert.ok(await MediaAsset.findById(entry._id));
  assert.equal(await mongoose.connection.db.collection('orderPhotos.chunks').countDocuments({ files_id: new mongoose.Types.ObjectId(unused._id) }), 0);
});
