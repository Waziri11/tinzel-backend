// Disposable, loopback-only HTTP stress test. Never loads .env or uses production data.
// Run: node scripts/mediaStressTest.js [absolute-output-directory]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MagazineForm } from '../src/models/MagazineForm.model.js';
import { Order } from '../src/models/Order.model.js';
import { AuditLog } from '../src/models/AuditLog.model.js';
import { StaffUser } from '../src/models/StaffUser.model.js';
import { MediaAsset, MediaJob, UploadSession } from '../src/models/Media.model.js';
import { generateToken } from '../src/middlewares/auth.middleware.js';
import { runMediaJobs } from '../src/services/mediaJobService.js';

const MiB = 1024 * 1024;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const percentile = (xs, p) => xs.length ? Math.round([...xs].sort((a, b) => a - b)[Math.ceil(xs.length * p) - 1]) : null;
const distribution = (xs) => ({ n: xs.length, p50: percentile(xs, .5), p95: percentile(xs, .95), p99: percentile(xs, .99), max: xs.length ? Math.round(Math.max(...xs)) : null });

if (process.argv.includes('--server')) {
  // Require the parent's disposable URI; reject any remote database even if env is inherited.
  assert.match(process.env.STRESS_DB_URI, /^mongodb:\/\/127\.0\.0\.1:/);
  process.env.MEDIA_STORAGE = 'gridfs';
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const { default: app } = await import('../src/app.js');
  await mongoose.connect(process.env.STRESS_DB_URI, { maxPoolSize: 10 });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
  const samples = setInterval(() => {
    process.send({ type: 'sample', rss: process.memoryUsage().rss, heap: process.memoryUsage().heapUsed,
      loopP99Ms: lag.percentile(99) / 1e6, loopMaxMs: lag.max / 1e6 });
    lag.reset();
  }, 100);
  process.on('message', async (message) => {
    if (message.type === 'worker') {
      try { process.send({ type: 'result', id: message.id, value: await runMediaJobs(message.options) }); }
      catch (e) { process.send({ type: 'result', id: message.id, error: e.message }); }
    }
    if (message.type === 'stop') {
      clearInterval(samples); lag.disable(); server.closeAllConnections();
      await new Promise((r) => server.close(r)); await mongoose.disconnect(); process.exit(0);
    }
  });
  process.send({ type: 'ready', port: server.address().port });
} else {
  const output = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'tinzel-media-stress-')));
  fs.mkdirSync(output, { recursive: true });
  const cache = path.resolve(import.meta.dirname, '../node_modules/.cache/mongodb-memory-server');
  const binary = fs.readdirSync(cache).find((name) => name.startsWith(`mongod-${process.arch}-${process.platform}-`));
  const mongo = await MongoMemoryServer.create({ binary: { systemBinary: path.join(cache, binary) }, instance: { ip: '127.0.0.1' } });
  let child, log, current, base;
  const pending = new Map(); const allSessions = []; const checks = [];
  const report = { startedAt: new Date().toISOString(), scope: 'Isolated HTTP API and MongoDB on loopback; app in separate process; no production load',
    environment: { node: process.version, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0].model, cores: os.cpus().length, ramGiB: os.totalmem() / MiB / 1024, poolSize: 10,
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }, phases: [], checks };
  function begin(name, config = {}) {
    assert.equal(current, undefined);
    current = { name, ...config, started: performance.now(), requests: [], failures: [], journeys: [], bytes: 0, samples: [], errors: [] };
  }
  function end(extra = {}) {
    const s = current; current = undefined;
    const elapsedMs = performance.now() - s.started;
    const groups = [...new Set(s.requests.map((r) => r.kind))];
    const result = { name: s.name, clients: s.clients, filesPerClient: s.filesPerClient, elapsedMs: Math.round(elapsedMs),
      requests: s.requests.length, failures: s.failures, errors: s.errors, transferredMiB: +(s.bytes / MiB).toFixed(2),
      uploadMiBPerSecond: +(s.bytes / MiB / (elapsedMs / 1000)).toFixed(2), journeyMs: distribution(s.journeys),
      requestMs: Object.fromEntries(groups.map((g) => [g, distribution(s.requests.filter((r) => r.kind === g).map((r) => r.ms))])),
      peakAppRSSMiB: Math.round(Math.max(0, ...s.samples.map((v) => v.rss)) / MiB),
      peakHeapMiB: Math.round(Math.max(0, ...s.samples.map((v) => v.heap)) / MiB),
      worstSampleLoopP99Ms: Math.round(Math.max(0, ...s.samples.map((v) => v.loopP99Ms))), ...extra };
    report.phases.push(result); fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ phase: result.name, elapsedMs: result.elapsedMs, requests: result.requests, failures: result.failures.length,
      errors: result.errors.length, MiBps: result.uploadMiBPerSecond, rssMiB: result.peakAppRSSMiB, ...extra }));
    return result;
  }
  const rpc = (options = {}) => new Promise((resolve, reject) => {
    const id = randomUUID(); pending.set(id, { resolve, reject }); child.send({ type: 'worker', id, options });
  });
  async function request(url, session, body, method = body === undefined ? 'GET' : 'POST', binary = false, expected) {
    const started = performance.now(); const phase = current;
    const headers = { ...(session?.token ? { 'X-Upload-Token': session.token } : {}), ...(session?.auth ? { Authorization: `Bearer ${session.auth}` } : {}),
      ...(body !== undefined ? { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' } : {}) };
    const response = await fetch(base + url, { method, headers, body: body === undefined ? undefined : binary ? body : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    const data = await response.json();
    const kind = url.includes('/chunks/') ? 'chunk' : url.endsWith('/submit') ? 'submit' : url.endsWith('/complete') ? 'complete' : method === 'GET' ? 'status' : 'metadata';
    phase?.requests.push({ kind, ms: performance.now() - started, status: response.status });
    if (binary && phase) phase.bytes += body.length;
    if (!response.ok && response.status !== expected) phase?.failures.push({ kind, status: response.status, message: data.message });
    assert.ok(response.ok || response.status === expected, `${response.status} ${JSON.stringify(data)}`);
    if (expected) assert.equal(response.status, expected);
    return data;
  }
  const api = (suffix) => `/api/public/media${suffix}`;
  async function session() {
    const s = { id: randomUUID(), token: randomBytes(32).toString('hex'), ids: [] };
    await request(api('/sessions'), s, { id: s.id, slug: 'stress-test' }); allSessions.push(s); return s;
  }
  async function reserve(s, bytes, name = 'photo.jpg', type = 'image/jpeg') {
    const result = await request(api(`/sessions/${s.id}/assets`), s, { clientId: randomUUID(), name, size: bytes.length, contentType: type, fieldId: 'photos' });
    return result.entry;
  }
  async function upload(s, bytes, name, type) {
    const entry = await reserve(s, bytes, name, type); const url = api(`/sessions/${s.id}/assets/${entry._id}`);
    for (let n = 0; n < Math.ceil(bytes.length / MiB); n++) await request(`${url}/chunks/${n}`, s, bytes.subarray(n * MiB, (n + 1) * MiB), 'PUT', true);
    await request(`${url}/complete`, s, {}); s.ids.push(entry._id); return entry;
  }
  async function customer(files, bytes) {
    const started = performance.now(); const phase = current; const s = await session(); let next = 0;
    await Promise.all(Array.from({ length: Math.min(2, files) }, async () => {
      while (next < files) { const index = next++; await upload(s, bytes, `photo-${index}.jpg`); }
    }));
    s.body = { clientName: 'Synthetic stress test', clientWhatsApp: '0000000000', answers: {}, assetIds: s.ids };
    await request(api(`/sessions/${s.id}/submit`), s, s.body);
    s.orderId = (await Order.findOne({ mediaSessionId: s.id }).lean())._id.toString();
    phase?.journeys.push(performance.now() - started); return s;
  }
  async function streamDownload(url, file) {
    const started = performance.now(); const response = await fetch(base + url, { signal: AbortSignal.timeout(120000) });
    assert.equal(response.status, 200); const firstByteMs = performance.now() - started;
    const digest = createHash('sha256'); let bytes = 0; const fd = file ? fs.openSync(file, 'w') : null;
    try { for await (const data of response.body) { digest.update(data); bytes += data.length; if (fd !== null) fs.writeSync(fd, data); } }
    finally { if (fd !== null) fs.closeSync(fd); }
    return { bytes, sha256: digest.digest('hex'), firstByteMs: Math.round(firstByteMs), ms: Math.round(performance.now() - started) };
  }
  try {
    await mongoose.connect(mongo.getUri(), { maxPoolSize: 10 });
    await Promise.all([Order.init(), UploadSession.init(), MediaAsset.init(), MediaJob.init(), AuditLog.init()]);
    await MagazineForm.create({ title: 'Disposable stress test', slug: 'stress-test', isActive: true, price: 1,
      fields: [{ fieldId: 'photos', type: 'photo_group', label: 'Photos', validationRules: { maxPhotos: 100 } }] });
    const staff = await StaffUser.create({ name: 'Stress test manager', email: 'stress@example.test', passwordHash: 'not-a-password', role: 'manager', isActive: true });
    const auth = { auth: generateToken(staff) };
    // A fresh API process makes its memory measurements independent of the load generator.
    child = fork(import.meta.filename, ['--server'], { silent: true, env: { PATH: process.env.PATH, STRESS_DB_URI: mongo.getUri(), NODE_ENV: 'test' } });
    log = fs.createWriteStream(path.join(output, 'server.log')); child.stdout.pipe(log); child.stderr.pipe(log, { end: false });
    child.on('message', (m) => {
      if (m.type === 'sample') current?.samples.push(m);
      if (m.type === 'result') { const task = pending.get(m.id); pending.delete(m.id); m.error ? task.reject(new Error(m.error)) : task.resolve(m.value); }
    });
    const ready = await new Promise((resolve, reject) => {
      child.on('message', (m) => { if (m.type === 'ready') resolve(m); }); child.once('error', reject); child.once('exit', (code) => reject(new Error(`API exited ${code}`)));
    });
    base = `http://127.0.0.1:${ready.port}`;
    const jpeg = await sharp(randomBytes(2048 * 1536 * 3), { raw: { width: 2048, height: 1536, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
    report.fixture = { jpegBytes: jpeg.length, width: 2048, height: 1536, sha256: hash(jpeg), description: 'Valid high-entropy JPEG; reused bytes, separate assets and orders' };
    let largeOrder;
    for (const [clients, files] of [[1, 1], [1, 100], [5, 20], [10, 20], [20, 10], [40, 5]]) {
      begin(`${clients} customers x ${files} photos`, { clients, filesPerClient: files });
      const results = await Promise.allSettled(Array.from({ length: clients }, () => customer(files, jpeg)));
      for (const r of results) if (r.status === 'rejected') current.errors.push(r.reason.message);
      if (files === 100) largeOrder = results[0].value;
      end({ completedCustomers: results.filter((r) => r.status === 'fulfilled').length, previewBacklog: await MediaJob.countDocuments({ kind: 'preview', state: 'queued' }) });
    }
    begin('near-limit original and retry recovery');
    const png = await sharp(randomBytes(3000 * 2800 * 3), { raw: { width: 3000, height: 2800, channels: 3 } }).png().toBuffer();
    assert.ok(png.length < 25 * MiB && png.length > 24 * MiB);
    const big = await session(); const bigEntry = await upload(big, png, 'large.png', 'image/png');
    const downloaded = await streamDownload(api(`/assets/${bigEntry._id}`)); assert.equal(downloaded.sha256, hash(png));
    const recover = await session(); const entry = await reserve(recover, jpeg); const url = api(`/sessions/${recover.id}/assets/${entry._id}`);
    const first = jpeg.subarray(0, MiB);
    await request(`${url}/chunks/0`, recover, first, 'PUT', true);
    await Promise.all(Array.from({ length: 10 }, () => request(`${url}/chunks/0`, recover, first, 'PUT', true)));
    const status = await request(url, recover); assert.equal(status.chunks.length, 1);
    await request(`${url}/complete`, recover, {}, 'POST', false, 409);
    for (let n = 1; n < Math.ceil(jpeg.length / MiB); n++) await request(`${url}/chunks/${n}`, recover, jpeg.subarray(n * MiB, (n + 1) * MiB), 'PUT', true);
    await request(`${url}/complete`, recover, {}); recover.ids.push(entry._id);
    const actual = await streamDownload(api(`/assets/${entry._id}`)); assert.equal(actual.sha256, hash(jpeg));
    recover.body = { clientName: 'Retry customer', clientWhatsApp: '0000000000', answers: {}, assetIds: recover.ids };
    const duplicates = await Promise.all(Array.from({ length: 20 }, () => request(api(`/sessions/${recover.id}/submit`), recover, recover.body)));
    assert.equal(new Set(duplicates.map((r) => r.order.submissionId)).size, 1);
    assert.equal(await Order.countDocuments({ mediaSessionId: recover.id }), 1);
    const retryOrder = await Order.findOne({ mediaSessionId: recover.id }).lean();
    assert.equal(await AuditLog.countDocuments({ orderId: retryOrder._id, action: 'ORDER_SUBMITTED' }), 1);
    checks.push('24+ MiB original checksum preserved', '10 concurrent repeated chunks stored once', '20 concurrent finalizations create one order and one audit');
    end({ nearLimitBytes: png.length, checksumVerified: true, duplicateFinalizations: duplicates.length });

    begin('worker default batch and competing invocations');
    const before = await MediaJob.countDocuments({ kind: 'preview', state: 'queued' });
    const workers = await Promise.all([rpc(), rpc(), rpc()]);
    const after = await MediaJob.countDocuments({ kind: 'preview', state: 'queued' });
    assert.equal(workers.filter((r) => r.processed > 0).length, 1);
    end({ workerResults: workers, backlogBefore: before, backlogAfter: after });

    begin('100-photo ZIP creation during upload burst');
    assert.ok(largeOrder);
    const archivePath = `/api/designer/orders/${largeOrder.orderId}/photo-folder-download`;
    const archive = await request(archivePath, auth, { folder: 'Photos' });
    const mixed = await Promise.allSettled([rpc({ maxJobs: 20 }), ...Array.from({ length: 10 }, () => customer(5, jpeg))]);
    for (const r of mixed) if (r.status === 'rejected') current.errors.push(r.reason.message);
    const readyZip = await request(archivePath, auth, { folder: 'Photos' }); assert.equal(readyZip.state, 'ready');
    const archiveJob = await MediaJob.findById(archive.jobId).lean();
    const archiveFile = await mongoose.connection.db.collection('mediaArchives.files').findOne({ _id: new mongoose.Types.ObjectId(archiveJob.outputId) });
    end({ archiveBytes: archiveFile.length, archiveQueueToReadyMs: archiveJob.completedAt - archiveJob.createdAt, jobId: archiveJob._id });

    begin('10 simultaneous cached ZIP downloads');
    const zipFile = path.join(output, '100-photos.zip');
    const downloads = await Promise.all(Array.from({ length: 10 }, (_, i) => streamDownload(readyZip.url, i === 0 ? zipFile : undefined)));
    assert.equal(new Set(downloads.map((r) => r.sha256)).size, 1);
    const zipCheck = execFileSync('unzip', ['-t', zipFile], { encoding: 'utf8' }); assert.match(zipCheck, /No errors detected/);
    const names = execFileSync('unzip', ['-Z1', zipFile], { encoding: 'utf8' }).trim().split('\n'); assert.equal(names.length, 100);
    const extracted = execFileSync('unzip', ['-p', zipFile, names[0]], { maxBuffer: 30 * MiB }); assert.equal(hash(extracted), hash(jpeg));
    fs.unlinkSync(zipFile); // Generated disposable archive; keep hashes and metrics instead.
    const again = await request(archivePath, auth, { folder: 'Photos' }); assert.equal(again.jobId, archive.jobId);
    checks.push('100 ZIP entries pass CRC validation; sampled entry SHA matches original', '10 concurrent ZIP downloads identical; cached job reused');
    end({ totalDownloadMiB: +(downloads.reduce((n, r) => n + r.bytes, 0) / MiB).toFixed(2), downloadMs: distribution(downloads.map((r) => r.ms)), firstByteMs: distribution(downloads.map((r) => r.firstByteMs)), zipSha256: downloads[0].sha256, zipEntries: names.length });

    begin('90-second paced upload soak with worker');
    const soakStarted = performance.now(); const batches = []; const workerRuns = [rpc({ maxJobs: 100 })];
    for (let n = 0; n < 30; n++) {
      await pause(Math.max(0, soakStarted + n * 3000 - performance.now()));
      if (n === 20) workerRuns.push(rpc({ maxJobs: 100 }));
      batches.push(Promise.allSettled([customer(3, jpeg), customer(3, jpeg)]));
    }
    const soakResults = (await Promise.all(batches)).flat(); await Promise.all(workerRuns);
    await pause(Math.max(0, soakStarted + 90000 - performance.now()));
    for (const r of soakResults) if (r.status === 'rejected') current.errors.push(r.reason.message);
    const samples = current.samples; const thirds = [0, 1, 2].map((n) => samples.slice(Math.floor(samples.length * n / 3), Math.floor(samples.length * (n + 1) / 3)));
    end({ completedCustomers: soakResults.filter((r) => r.status === 'fulfilled').length, rssPeakByThirdMiB: thirds.map((s) => Math.round(Math.max(...s.map((v) => v.rss)) / MiB)), remainingPreviews: await MediaJob.countDocuments({ kind: 'preview', state: 'queued' }) });

    begin('drain remaining previews');
    const drain = await rpc({ maxJobs: 2000, budgetMs: 230000 });
    const assetCount = await MediaAsset.countDocuments(); const previewCount = await MediaAsset.countDocuments({ thumbnailId: { $exists: true, $ne: null } });
    const failed = await MediaJob.countDocuments({ kind: { $ne: 'lock' }, state: 'failed' });
    const queued = await MediaJob.countDocuments({ kind: { $ne: 'lock' }, state: 'queued' });
    const thumb = await fetch(base + api(`/assets/${bigEntry._id}/thumbnail`)); assert.equal(thumb.status, 200);
    const thumbBytes = Buffer.from(await thumb.arrayBuffer()); const meta = await sharp(thumbBytes).metadata(); assert.ok(meta.width <= 480 && meta.height <= 480);
    assert.equal(assetCount, previewCount); assert.equal(failed, 0); assert.equal(queued, 0);
    end({ processed: drain.processed, assetCount, previewCount, failedJobs: failed, queuedJobs: queued, largePngThumbnailBytes: thumbBytes.length });
    const orders = await Order.find().lean();
    assert.equal(orders.length, await AuditLog.countDocuments({ action: 'ORDER_SUBMITTED' }));
    const assets = await MediaAsset.find().lean();
    const jpegHash = hash(jpeg), pngHash = hash(png);
    assert.ok(assets.every((a) => a.sha256 === (a._id === bigEntry._id ? pngHash : jpegHash)));
    checks.push('All completed originals independently SHA-verified by worker', 'Order and submission-audit totals match', 'All queued previews drained without failed jobs');
    report.totals = { orders: orders.length, assets: assets.length, originalMiB: +(assets.reduce((n, a) => n + a.size, 0) / MiB).toFixed(2),
      httpRequests: report.phases.reduce((n, p) => n + p.requests, 0), unexpectedHttpFailures: report.phases.reduce((n, p) => n + p.failures.length, 0) };
    report.completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, totals: report.totals, checks }));
  } catch (error) {
    report.fatal = error.stack; fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2)); throw error;
  } finally {
    if (child && child.exitCode === null) { child.send({ type: 'stop' }); await once(child, 'exit'); }
    log?.end(); await mongoose.disconnect(); await mongo.stop();
  }
}
