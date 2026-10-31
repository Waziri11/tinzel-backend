import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app.js';
import { Order } from '../src/models/Order.model.js';
import { StaffUser } from '../src/models/StaffUser.model.js';
import { Notification } from '../src/models/Notification.model.js';
import { MagazineForm } from '../src/models/MagazineForm.model.js';
import { SystemConfig } from '../src/models/SystemConfig.model.js';
import { generateToken, generateClientToken } from '../src/middlewares/auth.middleware.js';
import { resetNotificationSettings, updateNotificationSettings, getNotificationHistory, getNotificationSummary } from '../src/services/notificationService.js';
import { runWorkflowNotifications, retryWorkflowNotification } from '../src/services/workflowNotificationService.js';
import { proofPdf } from './fixtures/proofPdf.js';
import { createSession, finalizeSession } from '../src/services/mediaSessionService.js';

let mongo,server,base,form,admin,manager,designer,outsider;
before(async()=>{
  // Explicitly isolate all external providers, including environments with local .env credentials.
  for(const key of ['SMTP_USER','SMTP_PASS','TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_PHONE_NUMBER','NEXTSMS_API_KEY','NEXTSMS_USERNAME','NEXTSMS_PASSWORD'])delete process.env[key];
  mongo=await MongoMemoryServer.create();await mongoose.connect(mongo.getUri());
  await Promise.all([Order.init(),StaffUser.init(),Notification.init(),MagazineForm.init()]);
  form=await MagazineForm.create({title:'Handoff magazine',slug:'handoff-magazine',price:50000,fields:[],isActive:true});
  const staff=(name,role,preferredLanguage,phone,extra={})=>StaffUser.create({name,email:`${name}@example.test`,role,preferredLanguage,phone,passwordHash:'unused',...extra});
  admin=await staff('Admin','admin','en','0712000001');manager=await staff('Manager','manager','sw','0712000002');
  designer=await staff('Designer','designer','en','0712000003',{maxActiveWorkload:20});
  outsider=await staff('Outsider','designer','sw','0712000004',{isEligibleForAssignment:false});
  server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await mongoose.disconnect();await mongo.stop();});
beforeEach(async()=>{await resetNotificationSettings();});
async function request(path,body,token,method=body===undefined?'GET':'POST') {
  const multipart=body instanceof FormData;
  const response=await fetch(`${base}/api${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(!multipart&&body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:multipart?body:JSON.stringify(body)});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data={text};}return {status:response.status,data};
}
async function fresh(status='in_design') {return Order.create({submissionId:`SUB-${new mongoose.Types.ObjectId()}`,formId:form._id,formTitle:form.title,clientName:'Client',clientWhatsApp:'0712000010',clientPreferredLanguage:'en',status,assignedDesigner:designer._id});}
async function drain(order,options={}) {return runWorkflowNotifications({orderId:order._id,reconcile:false,...options});}
const notices=(order,type)=>Notification.find({orderId:order._id,template:type}).lean();

test('complete HTTP workflow notifies each next recipient, including correction rounds, both languages and printer channels',async()=>{
 const auth=generateToken(admin),designAuth=generateToken(designer);
 const submitted=await request('/public/forms/handoff-magazine/submit',{clientName:'Asha',clientWhatsApp:'0712000010',clientEmail:'asha@example.test',clientPreferredLanguage:'en',answers:{}});
 assert.equal(submitted.status,201,JSON.stringify(submitted.data));
 let order=await Order.findOne({submissionId:submitted.data.order.submissionId});const id=order._id;
 let rows=await notices(order,'order_submitted');assert.equal(rows.filter(row=>row.channel==='sms').length,3);
 assert.match(rows.find(row=>String(row.recipientUser)===String(admin._id)&&row.channel==='sms').message,/awaits payment verification/);
 assert.match(rows.find(row=>String(row.recipientUser)===String(manager._id)&&row.channel==='sms').message,/uthibitisho wa malipo/);
 let result=await request(`/manager/orders/${id}/verify-payment`,{lipaNambaReference:'PAY-123',amountPaid:50000},auth);assert.equal(result.status,200,JSON.stringify(result.data));
 order=await Order.findById(id);assert.equal(order.status,'assigned');
 assert.equal((await notices(order,'order_assigned')).filter(row=>row.channel==='sms').length,1);
 const count=await Notification.countDocuments({orderId:id});await request(`/manager/orders/${id}/verify-payment`,{lipaNambaReference:'PAY-123',amountPaid:50000},auth);assert.equal(await Notification.countDocuments({orderId:id}),count);
 const clientAuth=generateClientToken(order);
 const upload=async(version)=>{const body=new FormData();body.append('draftFile',new Blob([proofPdf(2)],{type:'application/pdf'}),'magazine.pdf');body.append('expectedVersion',String(version-1));
  const saved=await Order.findById(id),revision=saved.revisionRequests.at(-1);if(revision?.status==='open'){body.append('revisionRequestId',String(revision._id));body.append('verifyAll','true');}
  const res=await request(`/designer/orders/${id}/upload-draft`,body,designAuth);assert.equal(res.status,200,JSON.stringify(res.data));};
 const review=async(version,action)=>{const res=await request(`/manager/orders/${id}/review-draft`,{expectedVersion:version,action,feedback:'Please correct the heading',items:action==='return_to_designer'?[{text:'Correct the heading',pageReference:'1'}]:[]},auth);assert.equal(res.status,200,JSON.stringify(res.data));};
 const address=async()=>{const saved=await Order.findById(id),revision=saved.revisionRequests.at(-1);for(const item of revision.items){const res=await request(`/designer/orders/${id}/returns/${revision._id}/items/${item._id}`,{response:'Heading corrected'},designAuth,'PATCH');assert.equal(res.status,200,JSON.stringify(res.data));}};
 await upload(1);await review(1,'return_to_designer');await address();await upload(2);await review(2,'release_to_client');
 result=await request('/client/request-revision',{expectedVersion:2,items:[{text:'Replace photograph',pageReference:'1'}]},clientAuth);assert.equal(result.status,200,JSON.stringify(result.data));
 await address();await upload(3);await review(3,'release_to_client');
 result=await request('/client/approve-draft',{expectedVersion:3},clientAuth);assert.equal(result.status,200,JSON.stringify(result.data));
 result=await request(`/designer/orders/${id}/upload-print-document`,{useApprovedDraft:true},designAuth);assert.equal(result.status,200,JSON.stringify(result.data));
 await SystemConfig.updateOne({key:'printer_whatsapp_phone'},{$set:{value:'+255712000099'}},{upsert:true});
 await SystemConfig.updateOne({key:'printer_preferred_language'},{$set:{value:'en'}},{upsert:true});
 for(const [suffix,body] of [ ['authorise-print',{}],['printer-update',{stage:'in_progress',notes:'Printer acknowledged receipt'}],['printer-update',{stage:'completed',notes:'Manager verified print completion'}],['authorise-dispatch',{carrier:'Test Courier',trackingReference:'SHIP-123',deliveryAddress:'Dar es Salaam',notes:'Courier collected'}],['close-order',{recipientName:'Asha',confirmationMethod:'phone_call',recipientFeedback:'Client confirmed receipt'}]]) {
  result=await request(`/manager/orders/${id}/${suffix}`,body,auth);assert.equal(result.status,200,JSON.stringify(result.data));
 }
 const expected=['payment_verified','order_assigned','draft_uploaded','draft_returned','draft_released','client_revision_requested','client_approved','print_document_uploaded','print_dispatched','printing_in_progress','printing_completed','order_dispatched','order_closed'];
 for(const type of expected){rows=await notices(order,type);assert.ok(rows.some(row=>row.channel==='in_system'),type);assert.ok(rows.some(row=>row.channel==='sms'),type);assert.ok(rows.every(row=>row.status==='simulated'||row.status==='delivered'),`${type}: ${JSON.stringify(rows.map(row=>[row.status,row.errorMessage]))}`);}
 rows=await notices(order,'print_dispatched');assert.equal(rows.filter(row=>row.channel==='sms').length,1);assert.equal(rows.filter(row=>row.channel==='whatsapp').length,1);assert.match(rows.find(row=>row.channel==='whatsapp').message,/POKEA TNZ/);
 const signed=rows.find(row=>row.channel==='whatsapp').metadata.actionUrl;
 assert.ok(signed.includes('/api/print-jobs/'));
 let file=await fetch(signed);assert.equal(file.status,200);assert.equal(file.headers.get('cache-control'),'private, no-store');assert.equal(Buffer.from(await file.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
 file=await fetch(signed.split('?')[0]);assert.equal(file.status,403);
 file=await fetch(signed.replace('sig=','sig=0'));assert.equal(file.status,403);
 assert.equal((await notices(order,'draft_uploaded')).filter(row=>row.recipientRole==='admin'&&row.channel==='sms').length,3);
 assert.equal(await Notification.countDocuments({orderId:id,recipientUser:outsider._id}),0);
 assert.equal((await getNotificationHistory({user:outsider})).length,0);
 assert.equal((await request('/client/order',undefined,clientAuth)).data.order.workflowEvents,undefined);
 const inbox=await request('/client/notifications',undefined,clientAuth);assert.equal(inbox.status,200);assert.ok(inbox.data.notifications.length);assert.ok(inbox.data.notifications.every(row=>row.recipient===undefined));
 const row=inbox.data.notifications[0];assert.equal((await request(`/client/notifications/${row._id}/read`,{},clientAuth,'PATCH')).status,200);
 const other=await fresh();assert.equal((await request(`/client/notifications/${row._id}/read`,{},generateClientToken(other),'PATCH')).status,404);
 assert.equal((await request('/client/notifications',undefined,auth)).status,401);
});

test('queued assignment alerts managers; contact failures are visible and language preferences are authenticated',async()=>{
 const order=await fresh();order.status='queued_for_assignment';await order.save();await drain(order);
 const rows=await notices(order,'assignment_queued');assert.equal(rows.filter(row=>row.channel==='sms').length,2);
 const auth=generateToken(designer);assert.equal((await request('/staff/preferences',{preferredLanguage:'sw'},auth,'PATCH')).status,200);
 assert.equal((await StaffUser.findById(designer._id)).preferredLanguage,'sw');
 assert.equal((await request('/staff/preferences',{preferredLanguage:'fr'},auth,'PATCH')).status,400);
 const clientAuth=generateClientToken(order);assert.equal((await request('/client/preferences',{preferredLanguage:'sw'},clientAuth,'PATCH')).status,200);
 assert.equal((await request('/client/order',undefined,clientAuth)).data.order.clientPreferredLanguage,'sw');
 await StaffUser.updateOne({_id:designer._id},{$set:{phone:''}});
 order.status='assigned';await order.save();await drain(order);
 const missing=(await notices(order,'order_assigned')).find(row=>row.channel==='sms');assert.equal(missing.status,'failed');assert.equal(missing.attempts,0);assert.match(missing.errorMessage,/phone/);
 await StaffUser.updateOne({_id:designer._id},{$set:{phone:'0712000003',preferredLanguage:'en'}});
 await retryWorkflowNotification(missing._id);const retried=await Notification.findById(missing._id);assert.equal(retried.status,'simulated');assert.match(retried.message,/assigned/);
});

test('worker persists attempts before sending, retries only the failed channel and stops after five attempts',async()=>{
 const order=await fresh();order.status='draft_manager_review';order.currentDraftVersion=1;await order.save();
 const start=new Date();let smsCalls=0,emailCalls=0;
 const send=async input=>{const stored=await Notification.findOne({orderId:order._id,recipientRole:input.recipientRole,channel:input.channel});assert.equal(stored.status,'queued');assert.ok(stored.attempts>0);if(input.channel==='sms'){smsCalls++;return {status:'failed',retryable:true};}if(input.channel==='email')emailCalls++;return {status:input.channel==='in_system'?'delivered':'sent'};};
 let now=start;
 for(const delay of [0,60000,300000,900000,3600000]){now=new Date(now.getTime()+delay);await drain(order,{send,now});}
 assert.equal(smsCalls,10);assert.equal(emailCalls,2);
 const rows=await notices(order,'draft_uploaded');assert.ok(rows.filter(row=>row.channel==='sms').every(row=>row.attempts===5&&!row.retryable&&row.attemptHistory.length===5));
 await drain(order,{send,now:new Date(now.getTime()+86400000)});assert.equal(smsCalls,10);
});

test('concurrent workers send once; expired in-flight provider attempts become unconfirmed without automatic repetition',async()=>{
 const order=await fresh();order.status='assigned';await order.save();let calls=0;
 const send=async input=>{calls++;await new Promise(resolve=>setTimeout(resolve,5));return {status:input.channel==='in_system'?'delivered':'sent'};};
 await Promise.all([drain(order,{send}),drain(order,{send}),drain(order,{send})]);assert.equal(calls,3);
 const event=(await Order.findById(order._id)).workflowEvents[0],row=await Notification.findOne({workflowEventKey:event.key,channel:'sms'});
 await Notification.updateOne({_id:row._id},{$set:{status:'queued'}});
 await Order.updateOne({_id:order._id,'workflowEvents.key':event.key},{$set:{'workflowEvents.$.state':'running','workflowEvents.$.leaseUntil':new Date(0)}});
 await drain(order,{send});assert.equal(calls,3);assert.equal((await Notification.findById(row._id)).status,'unconfirmed');
 await assert.rejects(()=>retryWorkflowNotification(row._id),/unknown/);
});

test('stale tasks, inactive recipients, disabled channels and unchanged saves do not send',async()=>{
 const order=await fresh();order.status='assigned';await order.save();const length=order.workflowEvents.length;
 order.clientName='Updated';await order.save();assert.equal(order.workflowEvents.length,length);
 order.assignedDesigner=outsider._id;await order.save();let sent=[];
 await drain(order,{send:async input=>{sent.push(input);return {status:'sent'};}});assert.ok(sent.every(input=>String(input.recipientUser)===String(outsider._id)));
 const returned=await fresh();returned.status='assigned';await returned.save();await updateNotificationSettings({channels:{sms:false,email:false,in_system:true}});
 await drain(returned);const rows=await notices(returned,'order_assigned');assert.equal(rows.find(row=>row.channel==='sms').status,'skipped');assert.equal(rows.find(row=>row.channel==='in_system').status,'delivered');
 const summary=await getNotificationSummary(outsider);assert.ok(summary.unreadCount<=sent.length);
});

test('resumable form submission creates one durable manager handoff even when retried',async()=>{
 const id=crypto.randomUUID(),token='a'.repeat(64);
 await createSession(form.slug,id,token);
 const body={clientName:'Resumable Client',clientWhatsApp:'0712000088',clientPreferredLanguage:'sw',answers:{},assetIds:[]};
 const first=await finalizeSession(id,token,body),second=await finalizeSession(id,token,body);assert.equal(first.order.submissionId,second.order.submissionId);
 const order=await Order.findOne({submissionId:first.order.submissionId});assert.equal(order.workflowEvents.length,1);assert.equal(order.clientPreferredLanguage,'sw');
 assert.equal((await notices(order,'order_submitted')).filter(row=>row.recipientRole==='manager'&&row.channel==='sms').length,1);
});

test('notification worker endpoint requires its configured secret',async()=>{
 process.env.CRON_SECRET='test-notification-worker';assert.equal((await request('/internal/notification-jobs')).status,401);
 assert.equal((await request('/internal/notification-jobs',undefined,'test-notification-worker')).status,200);delete process.env.CRON_SECRET;
});

test('a rejected concurrent order save cannot create a notification event',async()=>{
 const original=await fresh(),first=await Order.findById(original._id),second=await Order.findById(original._id);
 first.status='assigned';await first.save();second.status='queued_for_assignment';await assert.rejects(()=>second.save(),error=>error.name==='VersionError');
 const saved=await Order.findById(original._id);assert.equal(saved.workflowEvents.length,1);assert.equal(saved.workflowEvents[0].type,'order_assigned');
});

test('legacy draft recovery sends once, leaves completed history intact and never backfills unrelated historical orders',async()=>{
 const {saveDraftPdf}=await import('../src/services/draftFileService.js');
 const order=await fresh('draft_manager_review');
 const assetId=await saveDraftPdf({originalname:'legacy.pdf',mimetype:'application/pdf',buffer:proofPdf(1)},order._id,1);
 order.currentDraftVersion=1;order.draftVersions.push({versionNumber:1,assetId,uploadedAt:new Date(),managerReview:{status:'pending'}});
 order.draftEvents.push({key:'draft:legacy-session',version:1,state:'pending',createdAt:new Date(),actor:{type:'designer',name:'Designer'}});await order.save();
 await runWorkflowNotifications({orderId:order._id});const count=await Notification.countDocuments({orderId:order._id});assert.ok(count>0);
 await runWorkflowNotifications({orderId:order._id});assert.equal(await Notification.countDocuments({orderId:order._id}),count);
 const saved=await Order.findById(order._id);assert.equal(saved.draftEvents[0].state,'done');assert.equal(saved.workflowEvents.length,1);
 const historical=await fresh('closed');await runWorkflowNotifications({orderId:historical._id});assert.equal(await Notification.countDocuments({orderId:historical._id}),0);
});

test('delayed messages use the saved recipient language, legacy defaults and active recipient list',async()=>{
 const order=await fresh();order.status='draft_manager_review';order.currentDraftVersion=1;await order.save();
 await StaffUser.collection.updateOne({_id:manager._id},{$unset:{preferredLanguage:''}});
 await drain(order);
 const sw=(await notices(order,'draft_uploaded')).find(row=>String(row.recipientUser)===String(manager._id)&&row.channel==='sms');assert.equal(sw.metadata.language,'sw');assert.match(sw.message,/ukaguzi/);
 const next=await fresh();next.status='draft_manager_review';next.currentDraftVersion=1;await next.save();
 await StaffUser.updateOne({_id:manager._id},{$set:{preferredLanguage:'en'}});await StaffUser.updateOne({_id:admin._id},{$set:{isActive:false}});
 await drain(next);const rows=await notices(next,'draft_uploaded');assert.ok(rows.every(row=>String(row.recipientUser)!==String(admin._id)));assert.match(rows.find(row=>row.channel==='sms').message,/awaits your review/);
 await StaffUser.updateOne({_id:manager._id},{$set:{preferredLanguage:'sw'}});await StaffUser.updateOne({_id:admin._id},{$set:{isActive:true}});
});

test('SMS timeouts remain unconfirmed while explicit rate-limit rejection is retryable',async()=>{
 const {sendNotification}=await import('../src/services/notificationService.js');
 const original=globalThis.fetch;process.env.NEXTSMS_API_KEY='fake-isolated-key';
 try{
  globalThis.fetch=async()=>{throw Object.assign(new Error('timeout'),{name:'TimeoutError'});};
  const uncertain=await sendNotification({to:'0712000001',channel:'sms',message:'Test only',metadata:{forceNextSms:true,workflow:true},skipPersistence:true});assert.equal(uncertain.status,'unconfirmed');assert.notEqual(uncertain.retryable,true);
  globalThis.fetch=async()=>new Response(JSON.stringify({message:'Rate limited'}),{status:429});
  const rejected=await sendNotification({to:'0712000001',channel:'sms',message:'Test only',metadata:{forceNextSms:true,workflow:true},skipPersistence:true});assert.equal(rejected.status,'failed');assert.equal(rejected.retryable,true);
 }finally{globalThis.fetch=original;delete process.env.NEXTSMS_API_KEY;}
});

test('existing orders acknowledge printing once and assigning the same designer sends no handoff',async()=>{
 const legacy=await fresh('printing_sent');legacy.printingDetails={printerPhone:'+255712000099',sentAt:new Date()};await legacy.save();
 const response=await request(`/manager/orders/${legacy._id}/printer-update`,{stage:'in_progress',notes:'Printer confirmed receipt'},generateToken(admin));assert.equal(response.status,200);
 const rows=await notices(legacy,'printing_in_progress');assert.equal(rows.filter(row=>row.channel==='sms').length,3);assert.equal(rows.filter(row=>row.channel==='in_system').length,3);
 const unchanged=await fresh('assigned');
 const {manualAssignOrder}=await import('../src/services/assignmentService.js');await manualAssignOrder(unchanged,designer._id,'Same designer',admin);
 assert.equal(await Notification.countDocuments({orderId:unchanged._id}),0);assert.equal((await Order.findById(unchanged._id)).workflowEvents.length,0);
});
