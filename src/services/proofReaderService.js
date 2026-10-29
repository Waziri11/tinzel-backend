import mongoose from 'mongoose';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { MediaJob, ProofPage } from '../models/Media.model.js';
import { Order } from '../models/Order.model.js';
import { draftRangeSource } from './draftFileService.js';

const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'proofPages' });
export const proofJobId = (orderId, version, page = 0) => `proof:${orderId}:${version}:${page}`;
export async function enqueueProof(orderId, version, page = 0, priority = 50) {
  const id=proofJobId(orderId,version,page);
  try {
    return await MediaJob.findOneAndUpdate({ _id: id }, {
      $setOnInsert: { kind: 'proof', orderId, version, page },
      $set: { requested: true }, $max: { priority },
    }, { upsert: true, returnDocument: 'after' }).lean();
  } catch(error) {
    if(error.code!==11000)throw error;
    return MediaJob.findOneAndUpdate({_id:id},{$set:{requested:true},$max:{priority}},{returnDocument:'after'}).lean();
  }
}
export async function requestProofBatch(orderId, version, pages) {
  const meta = await ProofPage.findOne({ orderId, version, page: 0 }).lean();
  if (!meta) await enqueueProof(orderId, version, 0, 300);
  if (!meta) return;
  const wanted = new Set();
  for (const number of pages) {
    const start = Math.floor((number - 1) / 5) * 5 + 1;
    for (let page = start; page < start + 5 && page <= meta.text.pageCount; page++) wanted.add(page);
  }
  for (const page of wanted) {
    if (!await ProofPage.exists({ orderId, version, page })) await enqueueProof(orderId, version, page, pages.includes(page) ? 400 : 100);
  }
}
export async function readBuffer(stream, maxBytes = 100 * 1024 * 1024, signal) {
  const abort=()=>stream.destroy(signal.reason);signal?.addEventListener('abort',abort,{once:true});
  const chunks = []; let size = 0;
  try { signal?.throwIfAborted(); for await (const chunk of stream) { size += chunk.length; if (size > maxBytes) throw new Error('Magazine exceeds protected reader size limit'); chunks.push(chunk); } }
  finally { signal?.removeEventListener('abort',abort);stream.destroy(); }
  return Buffer.concat(chunks);
}
export async function openPrivatePdf(draft, signal) {
  const source = await draftRangeSource(draft);
  if (source.length > 500 * 1024 * 1024) throw new Error('Magazine exceeds the 500 MB reader limit');
  const canvas = await import('@napi-rs/canvas');
  globalThis.DOMMatrix ??= canvas.DOMMatrix; globalThis.ImageData ??= canvas.ImageData; globalThis.Path2D ??= canvas.Path2D;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const initial = new Uint8Array(await readBuffer(source.read(0, Math.min(65536, source.length),signal), 65536,signal));
  const transport = new pdfjs.PDFDataRangeTransport(source.length, initial, true);
  let readSignal=signal;
  let task, proxy, stopped = false, bytesRead = initial.length, rejectFailure;
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  // Attach immediately so errors between parser operations cannot become unhandled rejections.
  failure.catch(() => {});
  const fail = (error) => { if (!stopped) { if(proxy)proxy.proofClosed=true; rejectFailure(error); task?.destroy().catch(() => {}); } };
  transport.requestDataRange = (start, end) => {
    if (stopped) return;
    readBuffer(source.read(start, end,readSignal), source.length,readSignal).then((bytes) => {
      readSignal?.throwIfAborted(); bytesRead += bytes.length;
      if (!stopped) transport.onDataRange(start, new Uint8Array(bytes));
    }).catch(fail);
  };
  transport.abort = () => { stopped = true; };
  const abort = () => fail(signal.reason || new Error('Page preparation cancelled'));
  signal?.addEventListener('abort', abort, { once: true });
  task = pdfjs.getDocument({ range: transport, length: source.length, rangeChunkSize: 65536, disableAutoFetch: true, disableStream: true, isEvalSupported: false, useSystemFonts: true });
  try {
    signal?.throwIfAborted();
    const pdf = await Promise.race([task.promise, failure]);proxy=pdf;
    signal?.removeEventListener('abort',abort);
    const destroy = task.destroy.bind(task);
    pdf.proofFailure = failure;
    pdf.proofBytesRead = () => bytesRead;
    pdf.proofClosed = false;pdf.proofCachedAt=Date.now();
    pdf.bindProofSignal=(jobSignal)=>{readSignal=jobSignal;const onAbort=()=>fail(jobSignal.reason);jobSignal?.addEventListener('abort',onAbort,{once:true});jobSignal?.throwIfAborted();return()=>{jobSignal?.removeEventListener('abort',onAbort);if(readSignal===jobSignal)readSignal=undefined;};};
    pdf.destroy = async () => { pdf.proofClosed = true; stopped = true; signal?.removeEventListener('abort', abort); await destroy(); };
    return pdf;
  } catch (error) { signal?.removeEventListener('abort', abort); await task.destroy().catch(() => {}); throw error; }
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
    return { image: await canvas.encode('webp',85), width: canvas.width, height: canvas.height, text };
  } finally { signal?.removeEventListener('abort', cancel); page.cleanup(); }
}
export async function buildProof(job, signal, context = new Map()) {
  const order = await Order.findById(job.orderId);
  const draft = order?.draftVersions.find((d) => d.versionNumber === job.version);
  if (!draft) throw new Error('Magazine version is unavailable');
  const phaseStarted=performance.now();
  const key = `${job.orderId}:${job.version}`;
  let pdf = context.get(key);
  if(pdf&&(pdf.proofClosed||Date.now()-pdf.proofCachedAt>60000)){await pdf.destroy();context.delete(key);pdf=null;}
  if (!pdf) {
    for (const previous of context.values()) await previous.destroy();
    context.clear(); pdf = await openPrivatePdf(draft, signal); context.set(key, pdf);
  }
  const openedAt=performance.now();
  const unbind=pdf.bindProofSignal(signal);
  try {
    if (pdf.numPages > 500) throw new Error('Magazine exceeds 500 page reader limit');
    if (!job.page) {
      await ProofPage.updateOne({ orderId: job.orderId, version: job.version, page: 0 }, { $set: { text: { pageCount: pdf.numPages } } }, { upsert: true });
      for (let page = 1; page <= Math.min(5, pdf.numPages); page++) { signal?.throwIfAborted(); await enqueueProof(job.orderId, job.version, page, page === 1 ? 400 : 100); }
    } else {
      const rendered = await Promise.race([renderProofPage(pdf, job.page, signal), pdf.proofFailure]);
      const renderedAt=performance.now();
      const output = bucket().openUploadStreamWithId(new mongoose.Types.ObjectId(job.outputId), 'page.webp', { contentType: 'image/webp' });
      await new Promise((resolve, reject) => { output.on('finish', resolve); output.on('error', reject); Readable.from(rendered.image).pipe(output); });
      if (job.owner && !await MediaJob.exists({_id:job._id,owner:job.owner,state:'running',leaseUntil:{$gt:new Date()}})) throw Object.assign(new Error('Worker lease lost before page publication'),{code:'PROOF_LEASE_LOST'});
      const old = await ProofPage.findOneAndUpdate({ orderId: job.orderId, version: job.version, page: job.page }, {
        $set: { format: 'webp', renderVersion: 2, width: rendered.width, height: rendered.height, imageId: output.id, text: rendered.text },
      }, { upsert: true });
      if (old?.imageId) await bucket().delete(old.imageId).catch(() => {});
      console.info(JSON.stringify({event:'proof_page_phases',job:job._id,sourceOpenMs:Math.round(openedAt-phaseStarted),renderMs:Math.round(renderedAt-openedAt),persistMs:Math.round(performance.now()-renderedAt),parserBytesRead:pdf.proofBytesRead(),outputBytes:rendered.image.length}));
    }
  } catch (error) { context.delete(key); await pdf.destroy(); throw error; } finally { unbind(); }
}
const escapeXml = (value) => String(value).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const watermarkCache=new Map();let watermarkBytes=0;
export async function watermarkedPage(page, identity, sessionKey='') {
  if(!sessionKey)return makeWatermarkedPage(page,`${identity} · ${new Date().toISOString()}`);
  const key=JSON.stringify([String(page.imageId),page.renderVersion,identity,sessionKey]);
  const cached=watermarkCache.get(key);
  if(cached&&cached.expires>Date.now()){watermarkCache.delete(key);watermarkCache.set(key,cached);return cached.bytes;}
  if(cached){watermarkBytes-=cached.bytes.length;watermarkCache.delete(key);}
  const bytes=await makeWatermarkedPage(page,`${identity} · ${new Date().toISOString()}`);
  if(bytes.length<=8*1024*1024){
    while(watermarkCache.size&&(watermarkCache.size>=40||watermarkBytes+bytes.length>64*1024*1024)){const [id,entry]=watermarkCache.entries().next().value;watermarkCache.delete(id);watermarkBytes-=entry.bytes.length;}
    watermarkCache.set(key,{bytes,expires:Date.now()+60000});watermarkBytes+=bytes.length;
  }
  return bytes;
}
const baseCache=new Map();let baseBytes=0;
async function baseImage(page){
  const key=String(page.imageId),cached=baseCache.get(key);
  if(cached){baseCache.delete(key);baseCache.set(key,cached);return cached;}
  const image=await readBuffer(bucket().openDownloadStream(page.imageId));
  if(image.length<=8*1024*1024){
    while(baseCache.size&&(baseCache.size>=16||baseBytes+image.length>32*1024*1024)){const [id,bytes]=baseCache.entries().next().value;baseCache.delete(id);baseBytes-=bytes.length;}
    baseCache.set(key,image);baseBytes+=image.length;
  }
  return image;
}
async function makeWatermarkedPage(page, identity) {
  const image = await baseImage(page);
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
