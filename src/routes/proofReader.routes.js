import { publicProofDiagnostic } from '../services/proofDiagnostics.js';
import { Router } from 'express';
import mongoose from 'mongoose';
import { Order } from '../models/Order.model.js';
import { MediaJob, ProofPage } from '../models/Media.model.js';
import { AuditLog } from '../models/AuditLog.model.js';
import { verifyStaffToken, verifyClientToken, requireRoles } from '../middlewares/auth.middleware.js';
import { enqueueProof, proofJobId, watermarkedPage, requestProofBatch } from '../services/proofReaderService.js';

const router = Router();
const windows = new Map();
router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store, max-age=0'); res.set('X-Content-Type-Options', 'nosniff'); next(); });
async function access(req, res, next) {
  try {
    const orderId = req.clientAuth?.orderId || req.params.id;
    if (!mongoose.isValidObjectId(orderId)) return res.status(404).json({ message: 'Order not found' });
    const order = await Order.findById(orderId);
    const version = Number(req.params.version);
    const draft = order?.draftVersions.find((d) => d.versionNumber === version);
    if (!order || !draft) return res.status(404).json({ message: 'Magazine version not found' });
    if (req.user?.role === 'designer' && String(order.assignedDesigner) !== String(req.user._id)) return res.status(403).json({ message: 'Order is not assigned to you' });
    if (req.clientAuth && draft.managerReview?.status !== 'approved') return res.status(404).json({ message: 'Magazine version is not released' });
    req.proofOrder = order; req.proofVersion = version;
    req.proofSource = req.clientAuth ? 'client' : 'manager';
    req.proofCanComment = version === order.currentDraftVersion && (req.clientAuth ? order.status === 'client_review' : ['manager', 'admin'].includes(req.user.role) && order.status === 'draft_manager_review');
    const key = `${req.clientAuth ? 'client:' + orderId : 'staff:' + req.user._id}`;
    const now = Date.now();
    for (const [id, entry] of windows) if (entry.until < now) windows.delete(id);
    const entry = windows.get(key) || { count: 0, until: now + 60000 };
    if (++entry.count > 240) { res.set('Retry-After', '60'); return res.status(429).json({ message: 'Please wait before loading more pages' }); }
    windows.set(key, entry); next();
  } catch (e) { next(e); }
}
function visibleAnnotations(req) {
  return req.proofOrder.proofAnnotations.filter((a) => a.version === req.proofVersion && (req.clientAuth ? a.source === 'client' : a.submittedAt || (a.source === 'manager' && ['manager', 'admin'].includes(req.user.role))));
}
function install(prefix, auth) {
  router.use(prefix, ...auth, access, routes());
}
function routes() {
  const r = Router({ mergeParams: true });
  const describe = async (req) => {
    const orderId=req.proofOrder._id, version=req.proofVersion;
    const job = await MediaJob.findById(proofJobId(orderId,version)).lean();
    const metadata=await ProofPage.findOne({orderId,version,page:0}).lean();
    const pages=await ProofPage.find({orderId,version,page:{$gt:0}}).select('page width height -_id').lean();
    const pageCount=metadata?.text?.pageCount||0;
    const total=Math.min(5,pageCount);
    const failed=await MediaJob.find({orderId,version,kind:'proof',requested:true,state:'failed'}).select('page errorCode errorReference attempts retryable _id').lean();
    const coverReady=pages.some((p)=>p.page===1);
    const diagnostic=failed.find((j)=>j.page===0)||failed.find((j)=>j.page===1);
    return {pageBundle:process.env.PROOF_PAGE_BUNDLE!=='false',coverReady,state:coverReady?'ready':job?.state||'queued',message:!coverReady&&diagnostic?publicProofDiagnostic(diagnostic).message:undefined,diagnostics:failed.map(publicProofDiagnostic),
      pageCount,pages,opening:{total,ready:pages.filter((p)=>p.page<=total).length},failedPages:failed.map((j)=>j.page),
      canComment:req.proofCanComment,annotations:visibleAnnotations(req)};
  };
  r.get('/',async(req,res,next)=>{
    try { await requestProofBatch(req.proofOrder._id,req.proofVersion,[1]);res.json(await describe(req)); } catch(e){next(e);}
  });
  r.post('/prepare',async(req,res,next)=>{
    try {
      const pages=req.body.pages||[1];
      const metadata=await ProofPage.findOne({orderId:req.proofOrder._id,version:req.proofVersion,page:0}).lean();
      if(!Array.isArray(pages)||!pages.length||pages.length>2||pages.some((n)=>!Number.isInteger(n)||n<1||n>(metadata?.text?.pageCount||500)))return res.status(400).json({message:'Choose up to two valid pages to prepare'});
      await requestProofBatch(req.proofOrder._id,req.proofVersion,pages);
      // Dedicated workers consume the queue; HTTP requests never perform rendering.
      res.json(await describe(req));
    }catch(e){next(e);}
  });
  r.post('/retry', async (req, res, next) => {
    try {
      await MediaJob.updateMany({ orderId: req.proofOrder._id, version: req.proofVersion, kind: 'proof', state: 'failed' }, { $set: { state: 'queued', attempts: 0, runAfter: new Date(), error: '', errorCode: null, errorReference: null } });
      await enqueueProof(req.proofOrder._id, req.proofVersion); res.json({ success: true });
    } catch (e) { next(e); }
  });
  r.get('/pages/:page', async (req, res, next) => {
    try {
      const number = Number(req.params.page);
      if (!Number.isInteger(number) || number < 1) return res.status(404).json({ message: 'Page not found' });
      const page = await ProofPage.findOne({ orderId: req.proofOrder._id, version: req.proofVersion, page: number }).lean();
      if (!page) {
        const metadata=await ProofPage.findOne({orderId:req.proofOrder._id,version:req.proofVersion,page:0}).lean();
        if(metadata&&number>metadata.text.pageCount)return res.status(404).json({message:'Page not found'});
        await requestProofBatch(req.proofOrder._id,req.proofVersion,[number]);
        const job = await MediaJob.findById(proofJobId(req.proofOrder._id, req.proofVersion, number)).lean();
        return res.status(job?.state === 'failed' ? 422 : 202).json({ message: job?.state === 'failed' ? publicProofDiagnostic(job).message : 'Page is being prepared', ...(job?.state === 'failed' ? { diagnostic: publicProofDiagnostic(job) } : {}) });
      }
      const identity = req.clientAuth ? `${req.proofOrder.clientName} (${req.proofOrder.trackingId})` : `${req.user.name} (${req.user.email})`;
      await AuditLog.create({ actor: { type: req.clientAuth ? 'client' : req.user.role, name: identity }, action: 'PROOF_PAGE_VIEWED', orderId: req.proofOrder._id, details: { version: req.proofVersion, page: number } });
      if (req.query.text === '1') return res.json({ width: page.width, height: page.height, text: page.text });
      const started=performance.now();
      const view = /^[a-zA-Z0-9-]{8,80}$/.test(req.query.view||'') ? req.query.view : '';
      const image = await watermarkedPage(page, `${identity} · ${req.proofOrder.trackingId || req.proofOrder.submissionId} · v${req.proofVersion}`, view);
      res.set('Server-Timing',`watermark;dur=${Math.round(performance.now()-started)}`);
      if(req.query.bundle==='1' && process.env.PROOF_PAGE_BUNDLE !== 'false'){
        const metadata=Buffer.from(JSON.stringify({width:page.width,height:page.height,text:page.text}));
        const length=Buffer.alloc(4);length.writeUInt32BE(metadata.length);
        return res.type('application/vnd.tinzel.proof-page').send(Buffer.concat([length,metadata,image]));
      }
      res.type('webp').send(image);
    } catch (e) { next(e); }
  });
  r.get('/diagnostics', async(req,res,next)=>{
    try{
      if(!req.user||!['manager','admin'].includes(req.user.role))return res.status(403).json({message:'Staff diagnostics permission required'});
      const jobs=await MediaJob.find({orderId:req.proofOrder._id,version:req.proofVersion,kind:'proof'}).select('page state attempts error errorCode errorName errorReference attemptHistory leaseUntil updatedAt').lean();
      res.json({jobs});
    }catch(e){next(e);}
  });
  r.post('/annotations', async (req, res, next) => {
    try {
      if (!req.proofCanComment) return res.status(403).json({ message: 'This version is not open for your review' });
      const { page, rects, kind } = req.body;
      const text = String(req.body.text || '').trim();
      const metadata = await ProofPage.findOne({ orderId: req.proofOrder._id, version: req.proofVersion, page: 0 });
      if (!Number.isInteger(page) || page < 1 || page > (metadata?.text?.pageCount || 0) || !['text', 'area'].includes(kind) || !text || text.length > 4000 || !Array.isArray(rects) || !rects.length || rects.length > 200 || rects.some((r) => !['x','y','width','height'].every((k) => Number.isFinite(r[k]) && r[k] >= 0 && r[k] <= 1) || !r.width || !r.height || r.x + r.width > 1.002 || r.y + r.height > 1.002)) return res.status(400).json({ message: 'Choose a valid page selection and a comment of up to 4000 characters' });
      if (req.proofOrder.proofAnnotations.length >= 2000) return res.status(400).json({ message: 'This magazine has reached its comment limit' });
      req.proofOrder.proofAnnotations.push({ version: req.proofVersion, page, rects, kind, text, selectedText: String(req.body.selectedText || '').slice(0, 8000), source: req.proofSource,
        authorId: String(req.user?._id || req.proofOrder._id), authorName: req.user?.name || req.proofOrder.clientName });
      await req.proofOrder.save(); res.json({ annotations: visibleAnnotations(req) });
    } catch (e) { next(e); }
  });
  r.delete('/annotations/:annotationId', async (req, res, next) => {
    try {
      if (!mongoose.isValidObjectId(req.params.annotationId)) return res.status(400).json({ message: 'Invalid comment reference' });
      const annotation = req.proofOrder.proofAnnotations.id(req.params.annotationId);
      if (!req.proofCanComment || !annotation || annotation.version !== req.proofVersion || annotation.source !== req.proofSource || annotation.submittedAt) return res.status(403).json({ message: 'Comment cannot be discarded' });
      annotation.deleteOne(); await req.proofOrder.save(); res.json({ annotations: visibleAnnotations(req) });
    } catch (e) { next(e); }
  });
  return r;
}
install('/staff/:id/:version', [verifyStaffToken, requireRoles('manager', 'admin', 'designer')]);
install('/client/:version', [verifyClientToken]);
export default router;
