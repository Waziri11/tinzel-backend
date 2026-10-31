import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { waitUntil } from '@vercel/functions';
import { Order } from '../models/Order.model.js';
import { StaffUser } from '../models/StaffUser.model.js';
import { SystemConfig } from '../models/SystemConfig.model.js';
import { Notification } from '../models/Notification.model.js';
import { sendNotification, getNotificationSettings, isTriggerChannelEnabled } from './notificationService.js';
import { language, workflowMessage } from './workflowMessages.js';
import { workflowEvent } from './workflowEvents.js';
import { AuditLog } from '../models/AuditLog.model.js';
import { enqueueProof } from './proofReaderService.js';
import { signMediaPath } from './mediaSignService.js';

const DELAYS = [60000, 300000, 900000, 3600000];
const PHONE = /^\+?[\d\s().-]{9,22}$/;
const managerEvents = new Set(['order_submitted','assignment_queued','draft_uploaded','print_document_uploaded','printing_completed']);
const clientEvents = new Set(['order_submitted','payment_verified','draft_released','printing_in_progress','order_dispatched','order_closed']);
const designerEvents = new Set(['order_assigned','draft_returned','client_revision_requested','client_approved']);
const informedManagers = new Set(['client_revision_requested','client_approved','printing_in_progress','order_closed']);
const typeOf = event => event.type === 'draft_returned' && event.source === 'client' ? 'client_revision_requested' : event.type;
export function isEventRelevant(order, event) {
  const type = typeOf(event);
  if (order.status === 'on_hold') return false;
  if (['payment_verified','order_closed'].includes(type)) return true;
  if (type === 'order_assigned') return ['assigned','in_design','revision_requested'].includes(order.status) && String(order.assignedDesigner?._id || order.assignedDesigner) === event.designerId;
  if (['draft_uploaded','draft_released','draft_returned','client_revision_requested'].includes(type) && order.currentDraftVersion !== event.version) return false;
  if (['draft_returned','client_revision_requested'].includes(type)) return order.status === 'revision_requested' && String(order.revisionRequests?.at(-1)?._id || '') === event.revisionId;
  return order.status === event.status;
}
const eventFilter = (orderId, key, owner) => ({ _id: orderId, workflowEvents: { $elemMatch: { key, ...(owner ? { owner } : {}) } } });
async function setEvent(orderId, key, owner, fields) {
  return Order.updateOne(eventFilter(orderId,key,owner), { $set: Object.fromEntries(Object.entries(fields).map(([key,value])=>[`workflowEvents.$.${key}`,value])) });
}
async function recipientsFor(order, event) {
  const type = typeOf(event), recipients = [];
  if (managerEvents.has(type) || informedManagers.has(type)) {
    const staff = await StaffUser.find({role:{$in:['manager','admin']},isActive:true,deletedAt:null}).lean();
    recipients.push(...staff.map(person=>({id:String(person._id),role:person.role,name:person.name,email:person.email,phone:person.phone,language:language(person.preferredLanguage)})));
    if (!staff.length) recipients.push({id:'manager-team',role:'manager',name:'Manager Team',language:'sw'});
  }
  if (clientEvents.has(type)) recipients.push({id:`client:${order._id}`,role:'client',name:order.clientName,email:order.clientEmail,phone:order.clientWhatsApp,language:language(order.clientPreferredLanguage)});
  if (designerEvents.has(type)) {
    const designer = event.designerId && await StaffUser.findOne({_id:event.designerId,role:'designer',isActive:true,deletedAt:null}).lean();
    if (designer) recipients.push({id:String(designer._id),role:'designer',name:designer.name,email:designer.email,phone:designer.phone,language:language(designer.preferredLanguage)});
    else recipients.push({id:'missing-designer',role:'manager',name:'Designer unavailable',language:'sw'});
  }
  if (type === 'print_dispatched') {
    const config = await SystemConfig.findOne({key:'printer_preferred_language'}).lean();
    recipients.push({id:'printer',role:'printer',name:'Printing Partner',phone:order.printingDetails?.printerPhone,language:language(config?.value)});
  }
  return [...new Map(recipients.map(person=>[person.id,person])).values()];
}
async function currentRecipient(order, task) {
  if (mongoose.isValidObjectId(task.id)) {
    const person = await StaffUser.findOne({_id:task.id,isActive:true,deletedAt:null}).lean();
    if (!person || person.role !== task.role || (task.role === 'designer' && String(order.assignedDesigner?._id || order.assignedDesigner) !== task.id)) return null;
    return {...task,name:person.name,email:person.email,phone:person.phone,language:language(person.preferredLanguage)};
  }
  if (task.role === 'printer') {const config=await SystemConfig.findOne({key:'printer_preferred_language'}).lean();return {...task,language:language(config?.value)};}
  if (task.role === 'client') return {...task,language:language(order.clientPreferredLanguage),phone:order.clientWhatsApp,email:order.clientEmail};
  return task;
}
function actionUrl(order, event, role, channel) {
  const frontend = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/,'');
  if (role === 'client') return `${frontend}/track`;
  if (role === 'printer') {
    if (channel !== 'whatsapp') return '';
    const base = process.env.BACKEND_URL || event.baseUrl || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:5001');
    return `${base.replace(/\/$/,'')}${signMediaPath(`/api/print-jobs/${order._id}/${event.key}/file`,7*24*3600)}`;
  }
  if (['order_submitted','assignment_queued','payment_verified'].includes(typeOf(event))) return `${frontend}/staff/pre-design?orderId=${order._id}`;
  if(['manager','admin'].includes(role)) {
    const phase=['draft_uploaded','draft_returned','client_revision_requested','draft_released'].includes(typeOf(event))?'design-phase':'post-design';
    return `${frontend}/staff/${phase}?orderId=${order._id}`;
  }
  return `${frontend}/staff/design/orders/${order._id}`;
}
async function deliver(order, event, task, { send, now }) {
  const key = `${event.key}:${task.id}:${task.channel}`;
  let row = await Notification.findOne({deliveryKey:key});
  // A crash after starting a provider call has an uncertain outcome. Never send it blindly again.
  if (row?.status === 'queued' && row.attempts > 0) {
    await Notification.updateOne({_id:row._id,status:'queued'},{$set:{status:'unconfirmed',retryable:false,errorMessage:'Delivery was interrupted; provider acceptance is unconfirmed.'}});
    return null;
  }
  if (row && !(row.status === 'failed' && row.retryable && row.attempts < 5)) return null;
  if (row?.nextAttemptAt > now) return row.nextAttemptAt;
  const person = await currentRecipient(order,task), type = typeOf(event);
  const url = actionUrl(order,event,task.role,task.channel);
  const content = workflowMessage(type,order,event,{...task},person?.language || task.language,url);
  const metadata = { workflow:true, language:person?.language || task.language, actionUrl:url, versionNumber:event.version, trackingId:order.trackingId, submissionId:order.submissionId, phase:event.status };
  if (!row) {
    try {
      row = await Notification.create({deliveryKey:key,workflowEventKey:event.key,eventGroupId:`${event.key}:${task.id}`,orderId:order._id,
        recipient:person?.[task.channel === 'email' ? 'email' : 'phone'] || task.name,recipientName:task.name,recipientRole:task.role,
        recipientUser:mongoose.isValidObjectId(task.id)?task.id:null,channel:task.channel,template:type,...content,metadata,status:'queued',mode:'workflow',attempts:0});
    } catch (error) { if (error.code === 11000) return null; throw error; }
  }
  const settings = await getNotificationSettings();
  let skipReason = null, failure = null;
  if (!person) skipReason = 'Recipient is no longer responsible for this task.';
  else if (!isTriggerChannelEnabled(type,task.channel,settings)) skipReason = 'Disabled in notification settings.';
  else if (task.channel === 'sms' || task.channel === 'whatsapp') {
    if (!PHONE.test(person.phone || '') || !/^\+?\d{9,15}$/.test(String(person.phone).replace(/[\s().-]/g,''))) failure = 'Missing or invalid recipient phone number. Update the contact and retry.';
  } else if (task.channel === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(person.email || '')) failure = 'Missing or invalid recipient email address. Update the contact and retry.';
  if (skipReason || failure) {
    await Notification.updateOne({_id:row._id},{$set:{status:skipReason?'skipped':'failed',errorMessage:skipReason || failure,retryable:false,metadata}});
    return null;
  }
  const recipient = task.channel === 'in_system' ? person.name : task.channel === 'email' ? person.email : person.phone;
  const attempt = row.attempts+1;
  const historyIndex=row.attemptHistory.length;
  await Notification.updateOne({_id:row._id},{$set:{status:'queued',recipient,...content,metadata,retryable:false},$inc:{attempts:1},$push:{attemptHistory:{attempt,startedAt:now,status:'queued'}}});
  let result;
  try {
    result = await send({to:recipient,recipientName:person.name,recipientRole:person.role,recipientUser:row.recipientUser,eventGroupId:row.eventGroupId,
      channel:task.channel,template:type,...content,orderId:order._id,metadata,skipPersistence:true,fallbackToSms:false,mediaUrl:task.channel === 'whatsapp'?url:null});
  } catch { result = {status:'unconfirmed',error:'Provider acceptance is unconfirmed.'}; }
  const status = result.status === 'skipped' ? 'skipped' : result.status;
  const retryable = status === 'failed' && result.retryable === true && attempt < 5;
  const nextAttemptAt = retryable ? new Date(now.getTime()+DELAYS[attempt-1]) : null;
  await Notification.updateOne({_id:row._id},{$set:{status,mode:result.mode || 'workflow',twilioSid:result.sid || null,errorMessage:result.error ? (status === 'unconfirmed'?'Provider acceptance is unconfirmed.':'Notification provider rejected or could not accept the message.') : null,retryable,nextAttemptAt,
    [`attemptHistory.${historyIndex}.status`]:status,[`attemptHistory.${historyIndex}.completedAt`]:new Date()}});
  return nextAttemptAt;
}
export async function reconcileLegacyDraftEvents(limit=20) {
  const orders = await Order.find({draftEvents:{$elemMatch:{state:{$ne:'done'}}}}).limit(limit);
  for (const order of orders) for (const old of order.draftEvents || []) {
    if (old.state === 'done') continue;
    const key = `legacy:${old.key}`;
    await enqueueProof(order._id,old.version).catch(async()=>{await Order.updateOne({_id:order._id,'draftEvents.key':old.key},{$set:{'draftEvents.$.error':'Proof preparation requires recovery.'}});});
    await AuditLog.updateOne({orderId:order._id,action:'DRAFT_UPLOADED','details.uploadSessionId':old.key.slice(6)},{$setOnInsert:{actor:old.actor,orderId:order._id,action:'DRAFT_UPLOADED',details:{versionNumber:old.version,uploadSessionId:old.key.slice(6)}}},{upsert:true});
    const alreadyHandled = await Notification.exists({orderId:order._id,template:'draft_uploaded','metadata.versionNumber':old.version});
    if (!alreadyHandled && !order.workflowEvents.some(event=>event.type === 'draft_uploaded' && event.version === old.version)) {
      const event = workflowEvent(order,'draft_uploaded',key); event.version=old.version; event.status='draft_manager_review';
      await Order.updateOne({_id:order._id,'workflowEvents.key':{$ne:key}},{$push:{workflowEvents:event}});
    }
    await Order.updateOne({_id:order._id,'draftEvents.key':old.key},{$set:{'draftEvents.$.state':'done','draftEvents.$.completedAt':new Date()}});
  }
}
export async function runWorkflowNotifications({limit=20,orderId=null,send=sendNotification,now=new Date(),reconcile=true,budgetMs=45000}={}) {
  if (mongoose.connection.readyState !== 1) return {processed:0};
  const started=Date.now();
  if(reconcile) await reconcileLegacyDraftEvents(limit);
  const due = {$or:[{state:'pending',runAfter:{$not:{$gt:now}}},{state:'running',leaseUntil:{$lt:now}}]};
  const orders=await Order.find({...(orderId?{_id:orderId}:{}),workflowEvents:{$elemMatch:due}}).limit(limit).lean();
  let processed=0;
  for (const saved of orders) for (const event of saved.workflowEvents || []) {
    if (processed>=limit || Date.now()-started>=budgetMs) break;
    if(event.state === 'done' || event.state === 'skipped' || event.runAfter>now) continue;
    const owner=randomUUID();
    const claimed=await Order.updateOne({_id:saved._id,workflowEvents:{$elemMatch:{key:event.key,...due}}},{$set:{'workflowEvents.$.state':'running','workflowEvents.$.owner':owner,'workflowEvents.$.leaseUntil':new Date(now.getTime()+300000)}});
    if(!claimed.modifiedCount) continue;
    processed++;
    try {
      const order=await Order.findById(saved._id).lean();
      if(!isEventRelevant(order,event)) {await setEvent(saved._id,event.key,owner,{state:'skipped',completedAt:now});continue;}
      let tasks=event.tasks;
      if(!tasks) {
        const recipients=await recipientsFor(order,event);
        tasks=recipients.flatMap(person=>['in_system','sms',...(person.email?['email']:[]),...(person.role==='printer'?['whatsapp']:[])].map(channel=>({...person,channel})));
        await setEvent(saved._id,event.key,owner,{tasks});
      }
      const pending=[];
      for (const task of tasks) {
        if(Date.now()-started>=budgetMs) {pending.push(new Date(now.getTime()+60000));break;}
        const fresh=await Order.findById(saved._id).lean();
        if(!isEventRelevant(fresh,event)) break;
        const next=await deliver(fresh,event,task,{send,now}); if(next) pending.push(next);
      }
      await setEvent(saved._id,event.key,owner,pending.length?{state:'pending',runAfter:new Date(Math.min(...pending.map(Number)))}:{state:'done',completedAt:now});
    } catch {
      await setEvent(saved._id,event.key,owner,{state:'pending',runAfter:new Date(now.getTime()+60000),error:'Notification processing interrupted; awaiting recovery.'});
    }
  }
  return {processed};
}
export async function kickWorkflowNotifications(orderId) {
  const promise=runWorkflowNotifications({orderId,limit:20,reconcile:false}).catch(()=>({processed:0}));
  if(!process.env.NODE_TEST_CONTEXT && process.env.VERCEL === '1') {
    try { waitUntil(promise); return {scheduled:true}; } catch { /* Await outside a Vercel request context. */ }
  }
  return promise;
}
export async function retryWorkflowNotification(id,{confirmUncertain=false}={}) {
  const row=await Notification.findById(id);
  if(!row?.deliveryKey) return null;
  if(!['failed','undelivered','unconfirmed'].includes(row.status)) throw Object.assign(new Error('Only unsuccessful deliveries can be retried.'),{status:409});
  if(row.status==='unconfirmed' && !confirmUncertain) throw Object.assign(new Error('Provider acceptance is unknown. Confirm that a retry may send a duplicate.'),{status:409});
  const order=await Order.findById(row.orderId).lean(),event=order?.workflowEvents.find(item=>item.key===row.workflowEventKey);
  if(!event || !isEventRelevant(order,event)) throw Object.assign(new Error('This task is no longer current.'),{status:409});
  const claimed=await Notification.updateOne({_id:row._id,status:row.status,updatedAt:row.updatedAt,retries:row.retries},{$set:{status:'failed',retryable:true,attempts:0,nextAttemptAt:new Date()},$inc:{retries:1}});
  if(!claimed.modifiedCount)throw Object.assign(new Error('A retry is already being processed.'),{status:409});
  await setEvent(order._id,event.key,null,{state:'pending',runAfter:new Date()});
  return kickWorkflowNotifications(order._id);
}
