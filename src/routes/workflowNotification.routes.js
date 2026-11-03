import { runAuthAlerts } from '../services/authActivityService.js';
import { exportSecurityEvents } from '../services/securityAuditService.js';
import { runStaffCredentials } from '../services/staffCredentialService.js';
import mongoose from 'mongoose';
import { pipeline } from 'node:stream/promises';
import { Order } from '../models/Order.model.js';
import { draftRangeSource } from '../services/draftFileService.js';
import { verifySignedMediaRequest } from '../services/mediaSignService.js';
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { runWorkflowNotifications } from '../services/workflowNotificationService.js';
const router=Router();
router.get('/internal/security-audit-export',async(req,res)=>{
 const expected=Buffer.from(`Bearer ${process.env.CRON_SECRET || ''}`), actual=Buffer.from(String(req.headers.authorization || ''));
 if(!process.env.CRON_SECRET || expected.length!==actual.length || !timingSafeEqual(expected,actual))return res.sendStatus(401);
 try{res.json(await exportSecurityEvents());}catch{res.status(503).json({message:'Audit export unavailable'});}
});
router.get('/internal/notification-jobs',async(req,res)=>{
  const expected=Buffer.from(`Bearer ${process.env.CRON_SECRET || ''}`),actual=Buffer.from(String(req.headers.authorization || ''));
  if(!process.env.CRON_SECRET || expected.length!==actual.length || !timingSafeEqual(expected,actual)) return res.sendStatus(401);
  try {const authAlerts=await runAuthAlerts();const credentials=await runStaffCredentials();res.json({...await runWorkflowNotifications(),credentials,authAlerts});}catch {res.status(503).json({message:'Notification worker temporarily unavailable.'});}
});
// Retired bearer-only links never deliver original files.
router.get('/print-jobs/:orderId/:eventKey/file',(_req,res)=>res.status(410).json({message:'Request a new printer invitation from your manager.'}));
export default router;
