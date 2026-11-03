import { staffCredentialMessage } from './accountMessages.js';
import { randomInt, randomBytes, createCipheriv, createDecipheriv, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { waitUntil } from '@vercel/functions';
import { formatTanzanianPhone } from './smsService.js';
import { StaffUser } from '../models/StaffUser.model.js';
import { Notification } from '../models/Notification.model.js';
import { sendNotification, getNotificationSettings, isTriggerChannelEnabled } from './notificationService.js';

const DAY=24*60*60*1000, DELAYS=[60000,300000,900000,3600000];
const groups=['ABCDEFGHJKLMNPQRSTUVWXYZ','abcdefghjkmnpqrstuvwxyz','23456789','!@#$'];
const fail=(status,message,code)=>Object.assign(new Error(message),{status,code});
export function generateInitialPassword() {
  const chars=groups.map(group=>group[randomInt(group.length)]),alphabet=groups.join('');
  while(chars.length<8)chars.push(alphabet[randomInt(alphabet.length)]);
  for(let i=chars.length-1;i>0;i--){const j=randomInt(i+1);[chars[i],chars[j]]=[chars[j],chars[i]];}
  return chars.join('');
}
export function passwordErrors(value) {
  if(typeof value!=='string')return ['Enter a new password.'];
  const errors=[];
  if([...value].length<15)errors.push('Use at least 15 characters. A phrase of unrelated words works well.');
  if(Buffer.byteLength(value,'utf8')>72)errors.push('Use at most 72 bytes (fewer characters for some languages).');
  if(/^(.)\1+$/.test(value) || /^(password|qwerty|123456|tinzel|admin)[\W\d]*$/i.test(value))errors.push('Choose a less common passphrase.');
  return errors;
}
function encryptionKey() {
  const raw=process.env.STAFF_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if(!raw || !/^[A-Za-z0-9+/]{43}=$/.test(raw))throw fail(503,'Staff credential encryption is not configured. Configure STAFF_CREDENTIAL_ENCRYPTION_KEY before issuing an initial password.','STAFF_CREDENTIAL_CONFIG_REQUIRED');
  const key=Buffer.from(raw,'base64');
  if(key.length!==32)throw fail(503,'Staff credential encryption requires a 32-byte base64 key.','STAFF_CREDENTIAL_CONFIG_REQUIRED');
  return key;
}
export function decryptInitialPassword(user) {
  const payload=user.credentialJob?.payload;
  if(!payload)throw fail(409,'Initial credentials are no longer available. Issue a new initial password.');
  const decipher=createDecipheriv('aes-256-gcm',encryptionKey(),Buffer.from(payload.iv,'base64'));
  decipher.setAAD(Buffer.from(`${user._id}:${user.credentialGeneration}`));
  decipher.setAuthTag(Buffer.from(payload.tag,'base64'));
  return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext,'base64')),decipher.final()]).toString('utf8');
}
export async function initialCredentialFields(staffId,generation=1,now=new Date()) {
  const key=encryptionKey(),password=generateInitialPassword(),iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(`${staffId}:${generation}`));
  const ciphertext=Buffer.concat([cipher.update(password,'utf8'),cipher.final()]);
  return {passwordHash:await bcrypt.hash(password,10),mustChangePassword:true,temporaryPasswordExpiresAt:new Date(now.getTime()+DAY),passwordChangedAt:now,credentialGeneration:generation,
    credentialDelivery:{sms:{status:'queued',attempts:0},email:{status:'queued',attempts:0}},
    credentialJob:{generation,state:'pending',runAfter:now,payload:{iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}}};
}
export const validStaffPhone=value=>{try{formatTanzanianPhone(value);return true;}catch{return false;}};
export function publicStaff(user) {
  const source=typeof user.toObject==='function'?user.toObject():{...user};
  delete source.passwordHash;delete source.credentialJob;
  return {...source,mustChangePassword:Boolean(source.mustChangePassword),onboardingStatus:source.mustChangePassword?(new Date(source.temporaryPasswordExpiresAt)<=new Date()?'expired':'awaiting_first_sign_in'):'ready'};
}
export async function finishStaffCredentialDelivery(id,generation,reason='These initial credentials are no longer current.') {
  await Notification.updateMany({recipientUser:id,'metadata.staffCredential':true,'metadata.credentialGeneration':generation,status:{$in:['queued','failed']}},{$set:{status:'skipped',retryable:false,errorMessage:reason}});
  for(const channel of ['sms','email'])await StaffUser.updateOne({_id:id,credentialGeneration:generation,[`credentialDelivery.${channel}.status`]:{$in:['queued','failed']}},{$set:{[`credentialDelivery.${channel}.status`]:'skipped',[`credentialDelivery.${channel}.error`]:reason}});
  await StaffUser.updateOne({_id:id,credentialGeneration:generation},{$unset:{'credentialDelivery.error':1}});
}
export async function reissueInitialPassword(id,{expectedRole=null}={}) {
  const user=await StaffUser.findOne({_id:id,isActive:true,deletedAt:null,...(expectedRole?{role:expectedRole}:{})});
  if(!user)throw fail(404,'Active staff user not found.');
  if(!validStaffPhone(user.phone) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email))throw fail(400,'A valid email and phone number are required before issuing credentials.');
  const generation=Number(user.credentialGeneration || 0)+1;
  const fields=await initialCredentialFields(user._id,generation);
  fields.credentialJob.reason='reissue';
  const updated=await StaffUser.findOneAndUpdate({_id:user._id,...(expectedRole?{role:expectedRole}:{}),passwordHash:user.passwordHash,credentialGeneration:{$in:[generation-1,...(generation===1?[null]:[])]},tokenVersion:{$in:[user.tokenVersion || 0,...(!user.tokenVersion?[null]:[])]}},{$set:fields,$inc:{tokenVersion:1}},{returnDocument:'after',runValidators:true});
  if(!updated)throw fail(409,'This account changed. Refresh before issuing another password.');
  await finishStaffCredentialDelivery(user._id,user.credentialGeneration || 0).catch(()=>{});
  await kickStaffCredentials(updated._id);
  return StaffUser.findById(updated._id).select('-passwordHash');
}
const activeCredential=(user,generation,now)=>user?.isActive&&!user.deletedAt&&user.mustChangePassword&&user.credentialGeneration===generation&&user.temporaryPasswordExpiresAt>now;
async function credentialChannel(user,channel,owner,{send,now}) {
  const generation=user.credentialGeneration,deliveryKey=`staff:${user._id}:${generation}:${channel}`;
  let row=await Notification.findOne({deliveryKey});
  if(row?.status==='queued'&&row.attempts>0){await Notification.updateOne({_id:row._id,status:'queued'},{$set:{status:'unconfirmed',retryable:false,errorMessage:'Provider acceptance is unconfirmed after an interrupted delivery.'}});return {status:'unconfirmed',attempts:row.attempts};}
  if(row && !(row.status==='failed'&&row.retryable&&row.attempts<5) && !(row.status==='queued'&&row.attempts===0))return {status:row.status,attempts:row.attempts,error:row.errorMessage};
  if(row?.nextAttemptAt>now)return {status:'failed',attempts:row.attempts,nextAttemptAt:row.nextAttemptAt};
  if(!row){
    try {row=await Notification.create({deliveryKey,eventGroupId:`staff:${user._id}:${generation}`,recipient:channel==='sms'?user.phone:user.email,recipientName:user.name,recipientRole:user.role,recipientUser:user._id,channel,template:'staff_credentials',title:user.preferredLanguage==='en'?'Tinzel account credentials':'Taarifa za akaunti ya Tinzel',message:'Initial account credentials [REDACTED].',mode:'staff_credentials',status:'queued',metadata:{staffCredential:true,staffId:String(user._id),credentialGeneration:generation,language:user.preferredLanguage || 'sw'}});}
    catch(error){if(error.code===11000)return null;throw error;}
  }
  const fresh=await StaffUser.findOne({_id:user._id,'credentialJob.owner':owner}).select('+credentialJob');
  if(!activeCredential(fresh,generation,new Date(Math.max(Date.now(),now.getTime())))){await Notification.updateOne({_id:row._id},{$set:{status:'skipped',retryable:false,errorMessage:'These initial credentials are no longer current.'}});return {status:'skipped',attempts:row.attempts};}
  const settings=await getNotificationSettings();
  let reason;
  if(!isTriggerChannelEnabled('staff_credentials',channel,settings))reason='Disabled in notification settings.';
  const invalid=channel==='sms'?!validStaffPhone(fresh.phone):!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fresh.email || '');
  if(reason||invalid){const status=reason?'skipped':'failed',error=reason || 'Missing or invalid recipient contact.';await Notification.updateOne({_id:row._id},{$set:{status,errorMessage:error,retryable:false}});return {status,attempts:row.attempts,error};}
  const password=decryptInitialPassword(fresh),content=staffCredentialMessage(fresh,password,channel),attempt=row.attempts+1,historyIndex=row.attemptHistory.length;
  const changed=await Notification.updateOne({_id:row._id,status:row.status,attempts:row.attempts},{$set:{status:'queued',retryable:false,recipient:channel==='sms'?fresh.phone:fresh.email,title:content.title,'metadata.language':fresh.preferredLanguage || 'sw'},$inc:{attempts:1},$push:{attemptHistory:{attempt,startedAt:now,status:'queued'}}});
  if(!changed.modifiedCount)return null;
  // Fence the actual send against resets/deactivation after the attempt was persisted.
  const current=await StaffUser.findOne({_id:user._id,'credentialJob.owner':owner}).lean();
  let result;
  if(!activeCredential(current,generation,new Date(Math.max(Date.now(),now.getTime()))))result={status:'skipped'};
  else try {result=await send({to:channel==='sms'?fresh.phone:fresh.email,recipientName:fresh.name,recipientRole:fresh.role,channel,template:'staff_credentials',...content,skipPersistence:true,fallbackToSms:false,metadata:{staffCredential:true}});}
  catch{result={status:'unconfirmed'};}
  const retryable=result.status==='failed'&&result.retryable===true&&attempt<5;
  const nextAttemptAt=retryable?new Date(now.getTime()+DELAYS[attempt-1]):null;
  const error=['failed','unconfirmed'].includes(result.status)?(result.status==='unconfirmed'?'Provider acceptance is unconfirmed.':'Credential delivery failed.'):null;
  await Notification.updateOne({_id:row._id},{$set:{status:result.status,mode:result.mode || 'staff_credentials',retryable,nextAttemptAt,errorMessage:error,twilioSid:result.sid || null,[`attemptHistory.${historyIndex}.status`]:result.status,[`attemptHistory.${historyIndex}.completedAt`]:new Date()}});
  return {status:result.status,attempts:attempt,error,nextAttemptAt};
}
export async function runStaffCredentials({limit=10,staffId=null,send=sendNotification,now=new Date(),budgetMs=20000}={}) {
  if(mongoose.connection.readyState!==1)return {processed:0};
  const started=Date.now();
  const retiredFilter={credentialJob:{$ne:null},$or:[{mustChangePassword:false},{temporaryPasswordExpiresAt:{$lte:now}},{isActive:false},{deletedAt:{$ne:null}}]};
  const retired=await StaffUser.find(retiredFilter).select('_id credentialGeneration').limit(100).lean();
  for(const user of retired){
    const cleared=await StaffUser.updateOne({_id:user._id,credentialGeneration:user.credentialGeneration,...retiredFilter},{$unset:{credentialJob:1}});
    if(cleared.modifiedCount)await finishStaffCredentialDelivery(user._id,user.credentialGeneration,'These initial credentials have expired or are no longer current.');
  }
  const due={$or:[{'credentialJob.state':'pending','credentialJob.runAfter':{$not:{$gt:now}}},{'credentialJob.state':'running','credentialJob.leaseUntil':{$lt:now}}]};
  const users=await StaffUser.find({...due,...(staffId?{_id:staffId}:{})}).select('+credentialJob').limit(limit).lean();let processed=0;
  for(const user of users){
    if(Date.now()-started>=budgetMs)break;
    const owner=randomUUID(),generation=user.credentialGeneration;
    const claimed=await StaffUser.updateOne({_id:user._id,credentialGeneration:generation,...due},{$set:{'credentialJob.state':'running','credentialJob.owner':owner,'credentialJob.leaseUntil':new Date(now.getTime()+300000)}});
    if(!claimed.modifiedCount)continue;processed++;
    const fence={_id:user._id,credentialGeneration:generation,'credentialJob.owner':owner};
    try {
      const outcomes={},pending=[];
      for(const channel of ['sms','email']){const result=await credentialChannel(user,channel,owner,{send,now});if(result){outcomes[`credentialDelivery.${channel}`]=result;await StaffUser.updateOne({_id:user._id,credentialGeneration:generation},{$set:{[`credentialDelivery.${channel}`]:result}});if(result.nextAttemptAt)pending.push(result.nextAttemptAt);}}
      await StaffUser.updateOne(fence,{$unset:{'credentialDelivery.error':1},$set:{...outcomes,'credentialJob.state':pending.length?'pending':'done','credentialJob.runAfter':pending.length?new Date(Math.min(...pending.map(Number))):null}});
    }catch{await StaffUser.updateOne(fence,{$set:{'credentialJob.state':'pending','credentialJob.runAfter':new Date(now.getTime()+60000),'credentialDelivery.error':'Credential delivery could not resume. Check encryption configuration or issue a new initial password.'}});}
  }
  return {processed};
}
export async function kickStaffCredentials(staffId) {
  const promise=runStaffCredentials({staffId}).catch(()=>({processed:0}));
  if(!process.env.NODE_TEST_CONTEXT&&process.env.VERCEL==='1'){try{waitUntil(promise);return {scheduled:true};}catch{/* Await on local hosts. */}}
  return promise;
}
export async function retryStaffCredentials(id,channel,{confirmUncertain=false,generation=null,expectedRole=null}={}) {
  if(!['sms','email'].includes(channel))throw fail(400,'Choose SMS or email.');
  const user=await StaffUser.findOne({_id:id,...(expectedRole?{role:expectedRole}:{})}).select('+credentialJob');
  if(!user)throw fail(404,'Staff user not found.');
  if(generation!==null && generation!==user?.credentialGeneration)throw fail(409,'These initial credentials have been replaced. Refresh the account details.');
  if(!activeCredential(user,user?.credentialGeneration,new Date()) || !user.credentialJob?.payload)throw fail(409,'Initial credentials have expired or are no longer current. Issue a new initial password.');
  const row=await Notification.findOne({deliveryKey:`staff:${id}:${user.credentialGeneration}:${channel}`});
  if(!row || !['failed','unconfirmed','undelivered','skipped'].includes(row.status))throw fail(409,'This channel is not available for retry.');
  if(row.status==='unconfirmed'&&!confirmUncertain)throw fail(409,'Provider acceptance is unknown. Confirm that retrying may send a duplicate.');
  const updated=await Notification.updateOne({_id:row._id,status:row.status,retries:row.retries},{$set:{status:'failed',retryable:true,attempts:0,nextAttemptAt:new Date()},$inc:{retries:1}});
  if(!updated.modifiedCount)throw fail(409,'A retry is already in progress.');
  const scheduled=await StaffUser.updateOne({_id:user._id,...(expectedRole?{role:expectedRole}:{}),credentialGeneration:user.credentialGeneration},{$set:{'credentialJob.state':'pending','credentialJob.runAfter':new Date()}});
  if(!scheduled.matchedCount)throw fail(409,'This account changed. Refresh before retrying.');
  return kickStaffCredentials(user._id);
}
