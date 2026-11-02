import {randomUUID} from 'node:crypto';
import {SecurityEvent,SecurityEventDelivery} from '../models/SecurityEvent.model.js';
const fields=['actorId','role','action','orderId','version','fileHash','requestId','ipAddress','outcome','transferId'];
export function securityEventData(input) {
  const result={eventId:randomUUID(),expiresAt:new Date(Date.now()+365*86400000)};
  for(const key of fields)if(input[key]!==undefined)result[key]=input[key];
  return result;
}
export async function recordSecurityEvent(req, details) {
  const event=await SecurityEvent.create(securityEventData({actorId:String(req.user?._id || req.clientAuth?.orderId || ''),role:req.user?.role || (req.clientAuth?'client':'anonymous'),requestId:req.requestId,ipAddress:req.ip,...details}));
  // The immutable event itself is the durable outbox; missing delivery records are recreated by the worker.
  return event;
}
export async function exportSecurityEvents({send}={}) {
  if(!send){
    const url=process.env.SECURITY_AUDIT_EXPORT_URL, token=process.env.SECURITY_AUDIT_EXPORT_TOKEN;
    if(!url || !token || new URL(url).protocol!=='https:')throw new Error('Protected HTTPS audit destination is required');
    send=async event=>{
      const response=await fetch(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,'Idempotency-Key':event.eventId},body:JSON.stringify(event),signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error('Audit export failed');
    };
  }
  const events=await SecurityEvent.aggregate([
    {$lookup:{from:SecurityEventDelivery.collection.name,localField:'eventId',foreignField:'_id',as:'delivery'}},
    {$match:{'delivery.exportedAt':{$exists:false}}},{$sort:{createdAt:1}},{$limit:100},{$unset:'delivery'},
  ]);
  let exported=0;
  for(const event of events){
    await SecurityEventDelivery.updateOne({_id:event.eventId},{$setOnInsert:{expiresAt:event.expiresAt}},{upsert:true});
    const now=new Date();
    const lease=await SecurityEventDelivery.findOneAndUpdate({_id:event.eventId,exportedAt:null,nextAttemptAt:{$lte:now},$or:[{leaseUntil:null},{leaseUntil:{$lte:now}}]},{$set:{leaseUntil:new Date(Date.now()+30000)},$inc:{attempts:1}},{returnDocument:'after'});
    if(!lease)continue;
    try{await send(event);await SecurityEventDelivery.updateOne({_id:event.eventId},{$set:{exportedAt:new Date()},$unset:{leaseUntil:1}});exported++;}
    catch{await SecurityEventDelivery.updateOne({_id:event.eventId},{$set:{nextAttemptAt:new Date(Date.now()+60000)},$unset:{leaseUntil:1}});}
    if(exported>=100)break;
  }
  return {exported};
}
