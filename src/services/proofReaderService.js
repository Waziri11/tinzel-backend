import mongoose from 'mongoose';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { MediaJob, ProofPage } from '../models/Media.model.js';
import { Order } from '../models/Order.model.js';
import { openDraftPdf } from './draftFileService.js';

const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'proofPages' });
export const proofJobId = (orderId, version, page = 0) => `proof:${orderId}:${version}:${page}`;
export async function enqueueProof(orderId, version, page = 0) {
  return MediaJob.findOneAndUpdate({ _id: proofJobId(orderId, version, page) }, { $setOnInsert: {
    kind: 'proof', orderId, version, page,
  } }, { upsert: true, returnDocument: 'after' }).lean();
}
export async function readBuffer(stream, maxBytes = 100 * 1024 * 1024) {
  const chunks = []; let size = 0;
  try { for await (const chunk of stream) { size += chunk.length; if (size > maxBytes) throw new Error('Magazine exceeds protected reader size limit'); chunks.push(chunk); } }
  finally { stream.destroy(); }
  return Buffer.concat(chunks);
}
export async function openPdf(data) {
  const canvas = await import('@napi-rs/canvas');
  globalThis.DOMMatrix ??= canvas.DOMMatrix;
  globalThis.ImageData ??= canvas.ImageData;
  globalThis.Path2D ??= canvas.Path2D;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: true }).promise;
}
export async function renderProofPage(pdf, number, signal) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const page = await pdf.getPage(number);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(2, 1800 / Math.max(base.width, base.height)) });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
  const cancel = () => task.cancel(); signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted(); await task.promise;
    const content = await page.getTextContent();
    const { Util } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const text = content.items.filter((t) => t.str).map((t) => {
      const tx = Util.transform(viewport.transform, t.transform);
      const height = Math.hypot(tx[2], tx[3]);
      const angle = Math.atan2(tx[1], tx[0]);
      const ascent = (content.styles[t.fontName]?.ascent || .8) * height;
      return { str: t.str, x: (tx[4] + ascent * Math.sin(angle)) / viewport.width, y: (tx[5] - ascent * Math.cos(angle)) / viewport.height,
        width: t.width * viewport.scale / viewport.width, height: height / viewport.height,
        angle: Math.atan2(tx[1], tx[0]) * 180 / Math.PI };
    });
    return { image: canvas.toBuffer('image/png'), width: canvas.width, height: canvas.height, text };
  } finally { signal?.removeEventListener('abort', cancel); page.cleanup(); }
}
export async function buildProof(job, signal) {
  const order = await Order.findById(job.orderId);
  const draft = order?.draftVersions.find((d) => d.versionNumber === job.version);
  if (!draft) throw new Error('Magazine version is unavailable');
  const pdf = await openPdf(await readBuffer(openDraftPdf(draft)));
  try {
    if (pdf.numPages > 500) throw new Error('Magazine exceeds 500 page reader limit');
    if (!job.page) {
      await ProofPage.updateOne({ orderId: job.orderId, version: job.version, page: 0 }, { $set: { text: { pageCount: pdf.numPages } } }, { upsert: true });
      for (let page = 1; page <= pdf.numPages; page++) { signal?.throwIfAborted(); await enqueueProof(job.orderId, job.version, page); }
    } else {
      const rendered = await renderProofPage(pdf, job.page, signal);
      const output = bucket().openUploadStreamWithId(new mongoose.Types.ObjectId(job.outputId), 'page.png', { contentType: 'image/png' });
      await new Promise((resolve, reject) => { output.on('finish', resolve); output.on('error', reject); Readable.from(rendered.image).pipe(output); });
      const old = await ProofPage.findOneAndUpdate({ orderId: job.orderId, version: job.version, page: job.page }, {
        $set: { width: rendered.width, height: rendered.height, imageId: output.id, text: rendered.text },
      }, { upsert: true });
      if (old?.imageId) await bucket().delete(old.imageId).catch(() => {});
    }
  } finally { await pdf.destroy(); }
}
const escapeXml = (value) => String(value).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
export async function watermarkedPage(page, identity) {
  const image = await readBuffer(bucket().openDownloadStream(page.imageId));
  const lines = String(identity).split(' · ').map((part) => part.slice(0, 160));
  const fontSize = Math.max(9, Math.min(18, (page.width - 40) / (Math.max(...lines.map((l) => l.length)) * .65)));
  const rows = [];
  for (let y = 45; y < page.height; y += 240) {
    lines.forEach((line, index) => rows.push(`<text x="20" y="${y + index * (fontSize + 4)}" fill="#333" fill-opacity="0.30" font-size="${fontSize}" font-family="sans-serif">${escapeXml(line)}</text>`));
  }
  const overlay = Buffer.from(`<svg width="${page.width}" height="${page.height}" xmlns="http://www.w3.org/2000/svg">${rows.join('')}</svg>`);
  return sharp(image).composite([{ input: overlay }]).webp({ quality: 85 }).toBuffer();
}
export function pendingAnnotations(order, source) {
  return (order.proofAnnotations || []).filter((a) => a.version === order.currentDraftVersion && a.source === source && !a.submittedAt);
}
export function assertNoPendingAnnotations(order, source) {
  if (pendingAnnotations(order, source).length) { const error = new Error('Submit or discard your saved correction comments before approving.'); error.status = 409; throw error; }
}
export function submitAnnotations(order, source, items = []) {
  const annotations = pendingAnnotations(order, source);
  const now = new Date();
  for (const annotation of annotations) annotation.submittedAt = now;
  return [...items, ...annotations.map((a) => ({ text: a.text, pageReference: String(a.page), annotationId: a._id }))];
}
