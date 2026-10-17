// Local transport benchmark. Uses a fresh disposable MongoDB, never .env.
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { randomUUID, randomBytes } from 'node:crypto';
import app from '../src/app.js';
import { MagazineForm } from '../src/models/MagazineForm.model.js';
import { createSession, reservePhoto, writeChunk, completePhoto, finalizeSession, CHUNK_BYTES } from '../src/services/mediaSessionService.js';

const mongo = await MongoMemoryServer.create();
await mongoose.connect(mongo.getUri());
const form = await MagazineForm.create({ title: 'Benchmark', slug: 'benchmark', isActive: true, price: 1,
  fields: [{ fieldId: 'photos', type: 'photo_group', label: 'Photos', validationRules: { maxPhotos: 100 } }] });
const bytes = randomBytes(3 * CHUNK_BYTES);
const reports = [];
try {
  for (const [clients, files] of [[1, 1], [1, 10], [1, 30], [1, 50], [1, 100], [5, 10], [10, 10]]) {
    const started = performance.now(); const finalizeMs = []; let peakRSS = process.memoryUsage().rss;
    const sample = setInterval(() => { peakRSS = Math.max(peakRSS, process.memoryUsage().rss); }, 20);
    await Promise.all(Array.from({ length: clients }, async () => {
      const id = randomUUID(), token = randomBytes(32).toString('hex');
      await createSession(form.slug, id, token);
      const ids = []; let next = 0;
      await Promise.all(Array.from({ length: Math.min(2, files) }, async () => {
        while (next++ < files) {
          const entry = await reservePhoto(id, token, { clientId: randomUUID(), name: 'benchmark.jpg', size: bytes.length, contentType: 'image/jpeg', fieldId: 'photos' });
          for (let n = 0; n < 3; n++) await writeChunk(entry, n, bytes.subarray(n * CHUNK_BYTES, (n + 1) * CHUNK_BYTES));
          await completePhoto(id, entry); ids.push(entry._id);
        }
      }));
      const mark = performance.now();
      await finalizeSession(id, token, { clientName: 'Benchmark', clientWhatsApp: '0000000000', answers: {}, assetIds: ids });
      finalizeMs.push(performance.now() - mark);
    }));
    clearInterval(sample); finalizeMs.sort((a, b) => a - b);
    reports.push({ clients, filesPerClient: files, fileMiB: 3, elapsedMs: Math.round(performance.now() - started),
      finalizeP50Ms: Math.round(finalizeMs[Math.floor(finalizeMs.length * 0.5)]), finalizeP95Ms: Math.round(finalizeMs[Math.min(finalizeMs.length - 1, Math.floor(finalizeMs.length * 0.95))]), peakAppRSSMiB: Math.round(peakRSS / 1024 / 1024) });
  }
  console.log(JSON.stringify({ scope: 'Local service/database benchmark; synthetic bytes; no network throttling or browser decoding; excludes MongoDB process memory', reports }, null, 2));
} finally { await mongoose.disconnect(); await mongo.stop(); }
