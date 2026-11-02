import mongoose from 'mongoose';
import {randomBytes} from 'node:crypto';
import {prepareMagazine,printSource} from './magazineDownloadService.js';
import {digest} from './accessSessionService.js';
const schema=new mongoose.Schema({_id:String,orderId:String,eventKey:String,fileHash:String,fingerprint:String,phone:String,revokedAt:Date,expiresAt:{type:Date,index:{expireAfterSeconds:0}}},{versionKey:false});
schema.index({orderId:1,eventKey:1});
export const PrinterInvitation=mongoose.model('PrinterInvitation',schema);
export const printFingerprint=order=>digest(JSON.stringify([order.printDocument?.url,order.printDocument?.uploadedAt,order.printDocument?.managerAuthorisedAt,order.printingDetails?.printerPhone]));
export function invitationMatches(invitation,order){return Boolean(invitation && order && !invitation.revokedAt && invitation.expiresAt>new Date() && invitation.fingerprint===printFingerprint(order) && ['printing_sent','printing_in_progress','printing_completed'].includes(order.status) && order.workflowEvents.some(e=>e.key===invitation.eventKey&&e.type==='print_dispatched'));}
export async function createPrinterInvitation(order,eventKey,{reissue=false}={}){
 const existing=await PrinterInvitation.findOne({orderId:String(order._id),eventKey}).sort({expiresAt:-1});
 if(existing&&!reissue)return existing;
 const prepared=await prepareMagazine(printSource(order));
 try{if(reissue)await PrinterInvitation.updateMany({orderId:String(order._id)},{$set:{revokedAt:new Date()}});
 return await PrinterInvitation.create({_id:randomBytes(24).toString('hex'),orderId:String(order._id),eventKey,fileHash:prepared.hash,fingerprint:printFingerprint(order),phone:order.printingDetails.printerPhone,expiresAt:new Date(Date.now()+86400000)});
 }finally{await prepared.cleanup();}
}
