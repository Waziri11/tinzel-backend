import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app.js';
import { Order } from '../src/models/Order.model.js';
import { StaffUser } from '../src/models/StaffUser.model.js';
import { generateToken, generateClientToken } from '../src/middlewares/auth.middleware.js';
import { updateNotificationSettings } from '../src/services/notificationService.js';
import { validateRevisionAudio, MAX_REVISION_AUDIO_BYTES } from '../src/services/revisionAudioService.js';

let mongo, server, base, designer, designerToken, otherToken;
const wav = Buffer.alloc(64);
wav.write('RIFF'); wav.writeUInt32LE(56, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(20, 40);
before(async () => {
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  await updateNotificationSettings({ channels: { in_system: false, email: false, sms: false } });
  designer = await StaffUser.create({ name: 'Assigned', email: 'audio@example.test', role: 'designer', passwordHash: 'unused' });
  const other = await StaffUser.create({ name: 'Other', email: 'other-audio@example.test', role: 'designer', passwordHash: 'unused' });
  designerToken = await generateToken(designer, { verifiedAt: new Date() });
  otherToken = await generateToken(other, { verifiedAt: new Date() });
  server = app.listen(0); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await mongo.stop(); });
async function fixture() {
  const order = await Order.create({ submissionId: `AUDIO-${new mongoose.Types.ObjectId()}`, formId: new mongoose.Types.ObjectId(), clientName: 'Audio client', clientWhatsApp: '0712000000', status: 'client_review', assignedDesigner: designer._id, currentDraftVersion: 1,
    draftVersions: [{ versionNumber: 1, managerReview: { status: 'approved' } }] });
  return { order, token: await generateClientToken(order) };
}
function body({ items = [], version = 1, bytes = wav } = {}) {
  const data = new FormData(); data.append('items', JSON.stringify(items)); data.append('expectedVersion', String(version));
  data.append('audio', new Blob([bytes], { type: 'audio/wav' }), 'changes.wav'); return data;
}
const send = (path, token, data) => fetch(base + path, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}` }, ...(data ? { body: data } : {}) });

test('audio-only request persists, plays for owner/assigned designer, and remains a required fix', async () => {
  const { order, token } = await fixture();
  const response = await send('/api/client/request-revision', token, body());
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.order.status, 'revision_requested');
  const round = result.order.revisionRequests[0], item = round.items[0];
  assert.equal(item.status, 'open'); assert.equal(item.audio.contentType, 'audio/wav'); assert.equal(item.audio.assetId, undefined);
  const clientPath = `/api/client/revisions/${round._id}/items/${item._id}/audio`;
  const staffPath = `/api/designer/orders/${order._id}/revisions/${round._id}/items/${item._id}/audio`;
  for (const [path, auth] of [[clientPath, token], [staffPath, designerToken]]) {
    const audio = await send(path, auth); assert.equal(audio.status, 200); assert.match(audio.headers.get('cache-control'), /no-store/);
    assert.deepEqual(Buffer.from(await audio.arrayBuffer()), wav);
  }
  assert.equal((await send(staffPath, otherToken)).status, 403);
  assert.equal((await send(clientPath, (await fixture()).token)).status, 404);
  assert.equal((await fetch(base + clientPath)).status, 401);
  const persisted = await Order.findById(order._id);
  assert.ok(persisted.revisionRequests[0].items[0].audio.assetId);
  const filesBefore = await mongoose.connection.db.collection('revisionAudio.files').countDocuments();
  assert.equal((await send('/api/client/request-revision', token, body())).status, 400);
  assert.equal(await mongoose.connection.db.collection('revisionAudio.files').countDocuments(), filesBefore);
});

test('text and audio both survive; stale/invalid/oversized uploads never create files', async () => {
  const { order, token } = await fixture();
  const filesBefore = await mongoose.connection.db.collection('revisionAudio.files').countDocuments();
  assert.equal((await send('/api/client/request-revision', token, body({ version: 0 }))).status, 409);
  assert.equal((await send('/api/client/request-revision', token, body({ bytes: Buffer.from('not audio') }))).status, 400);
  assert.equal((await send('/api/client/request-revision', token, body({ bytes: Buffer.alloc(MAX_REVISION_AUDIO_BYTES + 1) }))).status, 400);
  assert.equal(await mongoose.connection.db.collection('revisionAudio.files').countDocuments(), filesBefore);
  assert.equal((await Order.findById(order._id)).status, 'client_review');
  const response = await send('/api/client/request-revision', token, body({ items: [{ text: 'Fix the cover', pageReference: '1', audio: { assetId: new mongoose.Types.ObjectId() } }] }));
  const result = await response.json(); assert.equal(response.status, 200);
  assert.equal(result.order.revisionRequests[0].items.length, 2);
  assert.equal(result.order.revisionRequests[0].items[0].audio, undefined);
  assert.equal(result.order.revisionRequests[0].items[0].text, 'Fix the cover');
});

test('file validation rejects spoofed names and MIME types', () => {
  assert.equal(validateRevisionAudio({ originalname: 'note.wav', mimetype: 'audio/wav', buffer: wav }), 'audio/wav');
  assert.throws(() => validateRevisionAudio({ originalname: 'note.html', mimetype: 'audio/wav', buffer: wav }));
  assert.throws(() => validateRevisionAudio({ originalname: 'note.wav', mimetype: 'text/html', buffer: wav }));
});
