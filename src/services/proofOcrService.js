import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import { createWorker, PSM } from 'tesseract.js';
import { MediaJob, ProofPage } from '../models/Media.model.js';

export const OCR_VERSION = 1;
export const ocrJobId = (orderId, version, page) => `proof-ocr:${orderId}:${version}:${page}:${OCR_VERSION}`;
export async function requestProofOcr(orderId, version, pages, retry = false) {
  for (const page of pages) {
    const existing = await ProofPage.findOne({ orderId, version, page }).select('imageId ocrVersion').lean();
    if (!existing?.imageId || existing.ocrVersion >= OCR_VERSION) continue;
    const id = ocrJobId(orderId, version, page);
    try { await MediaJob.updateOne({ _id: id }, { $setOnInsert: { kind: 'proof', ocrOnly: true, orderId, version, page, priority: 25 }, $set: { requested: true } }, { upsert: true }); }
    catch (error) { if (error.code !== 11000) throw error; }
    if (retry) await MediaJob.updateOne({ _id: id, state: 'failed' }, { $set: { state: 'queued', attempts: 0, runAfter: new Date(), errorCode: null, errorReference: null } });
  }
}

// A process-local queue bounds WASM memory even when multiple requests kick workers.
let tail = Promise.resolve();
export async function recognizePage(image, width, height, signal) {
  const previous = tail;
  let unlock;
  tail = new Promise(resolve => { unlock = resolve; });
  await previous;
  let worker;
  const started = performance.now();
  try {
    signal?.throwIfAborted();
    worker = await createWorker(['eng', 'swa'], 1, {
      langPath: fileURLToPath(new URL('../../assets/ocr/', import.meta.url)), gzip: false, cacheMethod: 'none',
      // Worker failures are handled by the rejected operation and existing job retry policy.
      errorHandler: () => {},
    });
    signal?.throwIfAborted();
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
    let abort;
    const aborted = new Promise((_, reject) => {
      abort = () => { worker.terminate().catch(() => {}); reject(signal.reason); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    try {
      const { data } = await Promise.race([worker.recognize(image, {}, { blocks: true }), aborted]);
      const words = [];
      for (const block of data.blocks || []) for (const paragraph of block.paragraphs || []) for (const line of paragraph.lines || []) {
        const accepted = (line.words || []).filter(w => w.text?.trim() && w.confidence >= 40);
        for (const [index, word] of accepted.entries()) {
          const { x0, y0, x1, y1 } = word.bbox;
          if (x1 <= x0 || y1 <= y0) continue;
          words.push({ str: word.text, x: x0 / width, y: y0 / height, width: (x1 - x0) / width, height: (y1 - y0) / height,
            angle: 0, ascent: .8, fontFamily: 'sans-serif', dir: 'ltr', hasEOL: index === accepted.length - 1, source: 'ocr', confidence: word.confidence });
        }
      }
      console.info(JSON.stringify({ event: 'proof_ocr', durationMs: Math.round(performance.now() - started), rssBytes: process.memoryUsage().rss, words: words.length }));
      return words;
    } finally { signal?.removeEventListener('abort', abort); }
  } finally { await worker?.terminate().catch(() => {}); unlock(); }
}

export function mergeProofText(native = [], recognized = [], width = 1, height = 1) {
  const nativeText = native.filter(t => t.str?.trim() && !/[\uFFFD\u0000]/.test(t.str));
  return [...nativeText, ...recognized.filter(w => !nativeText.some(n => {
    const angle = (n.angle || 0) * Math.PI / 180;
    const dx = (w.x + w.width / 2 - n.x) * width, dy = (w.y + w.height / 2 - n.y) * height;
    const x = dx * Math.cos(angle) + dy * Math.sin(angle), y = -dx * Math.sin(angle) + dy * Math.cos(angle);
    return x >= 0 && x <= n.width * width && y >= 0 && y <= n.height * height;
  }))];
}

export async function buildProofOcr(job, signal) {
  const page = await ProofPage.findOne({ orderId: job.orderId, version: job.version, page: job.page }).lean();
  if (!page?.imageId) throw Object.assign(new Error('Prepare the magazine page before text recognition'), { code: 'PROOF_STORAGE_UNAVAILABLE' });
  const stream = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'proofPages' }).openDownloadStream(page.imageId);
  const chunks = []; let size = 0;
  try {
    for await (const chunk of stream) { signal?.throwIfAborted(); size += chunk.length; if (size > 16 * 1024 * 1024) throw new Error('OCR image exceeds memory limit'); chunks.push(chunk); }
  } finally { stream.destroy(); }
  const words = await recognizePage(Buffer.concat(chunks), page.width, page.height, signal);
  signal?.throwIfAborted();
  if (job.owner && !await MediaJob.exists({ _id: job._id, owner: job.owner, state: 'running', leaseUntil: { $gt: new Date() } })) throw Object.assign(new Error('Worker lease lost'), { code: 'PROOF_LEASE_LOST' });
  await ProofPage.updateOne({ _id: page._id, imageId: page.imageId }, { $set: { ocrVersion: OCR_VERSION, ocrText: words } });
}
