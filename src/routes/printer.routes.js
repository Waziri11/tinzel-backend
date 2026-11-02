import {Router} from 'express';
import {Order} from '../models/Order.model.js';
import {AccessSession} from '../models/AccessSession.model.js';
import {PrinterInvitation,invitationMatches,createPrinterInvitation} from '../services/printerAccessService.js';
import {issueChallenge,consumeChallenge,createSession,setSessionCookie,readSession,digest,requireRecentVerification} from '../services/accessSessionService.js';
import {verifyStaffToken,requireRoles} from '../middlewares/auth.middleware.js';
import {deliverMagazine,printSource} from '../services/magazineDownloadService.js';
import {recordSecurityEvent} from '../services/securityAuditService.js';
const router=Router();
const route=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(e){next(e);}};
async function load(id){const invitation=await PrinterInvitation.findById(id);const order=invitation&&await Order.findById(invitation.orderId);if(!invitationMatches(invitation,order))throw Object.assign(new Error('Print invitation unavailable or expired'),{status:404});return {invitation,order};}
router.post('/invitations/:id/otp',route(async(req,res)=>{const {invitation}=await load(req.params.id);res.json(await issueChallenge({subjectId:invitation.orderId,purpose:'printer',channel:'sms',destination:invitation.phone,ip:req.ip,scope:{invitationId:invitation._id}}));}));
router.post('/invitations/:id/verify',route(async(req,res)=>{const {invitation}=await load(req.params.id);const challenge=await consumeChallenge(req.body.challengeId,req.body.code,'printer',req.ip);if(challenge.scope.invitationId!==invitation._id)return res.sendStatus(403);
 const token=await createSession('printer',{_id:invitation.orderId},{verifiedAt:new Date(),scope:{invitationId:invitation._id}});setSessionCookie(res,'printer',token,600000);res.json({success:true,csrf:(await AccessSession.findById(digest(token))).csrf});}));
router.get('/invitations/:id/file',route(async(req,res)=>{const session=await readSession(req,'printer');const {invitation,order}=await load(req.params.id);if(session.scope.invitationId!==invitation._id)return res.sendStatus(403);req.user={_id:`printer:${invitation._id}`,role:'printer'};await deliverMagazine(req,res,order,printSource(order),{version:order.currentDraftVersion,expectedHash:invitation.fileHash});}));
router.post('/orders/:id/:action',verifyStaffToken,requireRoles('admin','manager'),requireRecentVerification,route(async(req,res)=>{const order=await Order.findById(req.params.id);if(!order)return res.sendStatus(404);
 if(req.params.action==='revoke'){await PrinterInvitation.updateMany({orderId:String(order._id)},{$set:{revokedAt:new Date()}});await recordSecurityEvent(req,{action:'PRINTER_ACCESS_REVOKED',orderId:String(order._id)});return res.json({success:true});}
 if(req.params.action!=='invite')return res.sendStatus(404);const event=order.workflowEvents.filter(e=>e.type==='print_dispatched').at(-1);if(!event || !['printing_sent','printing_in_progress','printing_completed'].includes(order.status))return res.sendStatus(409);
 const invitation=await createPrinterInvitation(order,event.key,{reissue:true});await recordSecurityEvent(req,{action:'PRINTER_INVITATION_CREATED',orderId:String(order._id)});res.json({url:`/printer/${invitation._id}`,expiresAt:invitation.expiresAt});}));
export default router;
