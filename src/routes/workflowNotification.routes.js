import mongoose from 'mongoose';
import { pipeline } from 'node:stream/promises';
import { Order } from '../models/Order.model.js';
import { draftRangeSource } from '../services/draftFileService.js';
import { verifySignedMediaRequest } from '../services/mediaSignService.js';
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { runWorkflowNotifications } from '../services/workflowNotificationService.js';
const router=Router();
router.get('/internal/notification-jobs',async(req,res)=>{
  const expected=Buffer.from(`Bearer ${process.env.CRON_SECRET || ''}`),actual=Buffer.from(String(req.headers.authorization || ''));
  if(!process.env.CRON_SECRET || expected.length!==actual.length || !timingSafeEqual(expected,actual)) return res.sendStatus(401);
  try {res.json(await runWorkflowNotifications());}catch {res.status(503).json({message:'Notification worker temporarily unavailable.'});}
});
// Only the explicitly authorized printer capability can retrieve this print file.
router.get('/print-jobs/:orderId/:eventKey/file',async(req,res)=>{
  if(!req.query.sig || !req.query.exp || !verifySignedMediaRequest(req).valid)return res.sendStatus(403);
  if(!mongoose.isValidObjectId(req.params.orderId))return res.sendStatus(404);
  try{
    const order=await Order.findById(req.params.orderId).lean();
    const event=order?.workflowEvents?.find(item=>item.key===req.params.eventKey && item.type==='print_dispatched');
    if(!event || !order.printDocument?.managerAuthorisedAt || event.printPath!==order.printDocument.url || event.printUploadedAt!==order.printDocument.uploadedAt?.toISOString())return res.sendStatus(404);
    const path=order.printDocument.url;
    const asset=path.match(/^\/api\/public\/drafts\/([a-f0-9]{24})$/i);
    const source=await draftRangeSource(asset?{assetId:asset[1]}:path.startsWith('tinzel/drafts/')?{storageProvider:'blob',blobPath:path}:(path.startsWith('/uploads/drafts/')||path.startsWith('/uploads/print/'))?{fileUrl:path}:{});
    res.set({'Content-Type':'application/pdf','Content-Length':String(source.length),'Cache-Control':'private, no-store','Content-Disposition':'attachment; filename="tinzel-print.pdf"'});
    await pipeline(source.read(0,source.length),res);
  }catch{if(res.headersSent)res.destroy();else res.sendStatus(404);}
});
export default router;
