import {Router} from 'express';
import mongoose from 'mongoose';
import {verifyStaffToken,requireRoles} from '../middlewares/auth.middleware.js';
import {requireRecentVerification} from '../services/accessSessionService.js';
import {Order} from '../models/Order.model.js';
import {SecurityEvent} from '../models/SecurityEvent.model.js';
import {AccessSession} from '../models/AccessSession.model.js';
import {recordSecurityEvent} from '../services/securityAuditService.js';
import {deliverMagazine,printSource} from '../services/magazineDownloadService.js';
import {permits} from '../services/authorizationService.js';
const router=Router();
router.use(verifyStaffToken);
router.get('/downloads',requireRoles('admin','manager'),async(req,res,next)=>{try{
 const query={action:{$in:['DOWNLOAD_AUTHORIZED','DOWNLOAD_COMPLETED','DOWNLOAD_INTERRUPTED','DOWNLOAD_DENIED']}};
 if(req.query.orderId)query.orderId=String(req.query.orderId);if(req.query.actorId)query.actorId=String(req.query.actorId);
 if(req.query.before && !Number.isNaN(Date.parse(req.query.before)))query.createdAt={$lt:new Date(req.query.before)};
 res.json({events:await SecurityEvent.find(query).sort({createdAt:-1}).limit(100).lean()});
}catch(e){next(e);}});
router.post('/orders/:id/revoke-client',requireRoles('admin','manager'),requireRecentVerification,async(req,res,next)=>{try{await AccessSession.deleteMany({kind:'client',subjectId:req.params.id});await recordSecurityEvent(req,{action:'CLIENT_SESSIONS_REVOKED',orderId:req.params.id});res.json({success:true});}catch(e){next(e);}});
router.get('/orders/:id/download/:version',async(req,res,next)=>{try{
 const order=mongoose.isValidObjectId(req.params.id)?await Order.findById(req.params.id):null;
 if(!permits(req.user,'magazine.download_original',order)){await recordSecurityEvent(req,{action:'DOWNLOAD_DENIED',orderId:req.params.id,outcome:'denied'});return res.sendStatus(403);}
 if(!req.accessSession.verifiedAt || Date.now()-req.accessSession.verifiedAt>600000)return res.status(403).json({errorCode:'OTP_REQUIRED',message:'Verify your identity before downloading'});
 const print=req.params.version==='print';const draft=print?printSource(order):order.draftVersions.find(d=>d.versionNumber===Number(req.params.version));
 if(!draft || print&&!order.printDocument?.url)return res.sendStatus(404);
 await deliverMagazine(req,res,order,draft,{version:print?order.currentDraftVersion:Number(req.params.version)});
}catch(e){next(e);}});
export default router;
