import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {MongoMemoryServer} from 'mongodb-memory-server';
import {createHash} from 'node:crypto';
process.env.NODE_ENV='test';process.env.SECURITY_OTP_SINK='true';
const {default:app}=await import('../src/app.js');
const {Order}=await import('../src/models/Order.model.js');
const {MagazineForm}=await import('../src/models/MagazineForm.model.js');
const {StaffUser}=await import('../src/models/StaffUser.model.js');
const {SecurityEvent}=await import('../src/models/SecurityEvent.model.js');
const {saveDraftPdf}=await import('../src/services/draftFileService.js');
const {createSession,otpSink,digest}=await import('../src/services/accessSessionService.js');
const {PrinterInvitation,createPrinterInvitation}=await import('../src/services/printerAccessService.js');
const {proofPdf}=await import('./fixtures/proofPdf.js');
let db,server,base,order,tokens={},pdf=proofPdf();
before(async()=>{db=await MongoMemoryServer.create();await mongoose.connect(db.getUri());const form=await MagazineForm.create({title:'Security',slug:'security-download',price:100});
 for(const role of ['admin','manager','designer']){const user=await StaffUser.create({name:role,email:`${role}@security.test`,role,passwordHash:'unused'});tokens[role]=await createSession('staff',user,{verifiedAt:new Date()});}
 const assetId=await saveDraftPdf({originalname:'fixture.pdf',buffer:pdf},new mongoose.Types.ObjectId(),1);
 order=await Order.create({submissionId:'SUB-SEC',trackingId:'TNZ-SEC',formId:form._id,clientName:'Synthetic',clientWhatsApp:'0712000000',status:'printing_sent',currentDraftVersion:1,draftVersions:[{versionNumber:1,assetId,managerReview:{status:'approved'}}],printDocument:{url:`/api/public/drafts/${assetId}`,uploadedAt:new Date(),managerAuthorisedAt:new Date()},printingDetails:{printerPhone:'0712000001'},workflowEvents:[{key:'security-print',type:'print_dispatched'}]});
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await mongoose.disconnect();await db.stop();});
const get=(path,role='manager')=>fetch(base+path,{headers:{Authorization:`Bearer ${tokens[role]}`}});
const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
test('only verified admin/manager get original bytes and durable transfer events',async()=>{
 for(const role of ['admin','manager']){const response=await get(`/api/security/orders/${order._id}/download/1`,role);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),pdf);}
 assert.equal((await get(`/api/security/orders/${order._id}/download/1`,'designer')).status,403);
 assert.equal((await fetch(base+`/api/security/orders/${order._id}/download/1`)).status,401);
 const events=await SecurityEvent.find({action:'DOWNLOAD_AUTHORIZED'});assert.equal(events.length,2);assert.equal(events[0].fileHash,createHash('sha256').update(pdf).digest('hex'));
 assert.equal(await SecurityEvent.countDocuments({action:'DOWNLOAD_DENIED'}),2);
});
test('audit failure prevents all original bytes',async()=>{const original=SecurityEvent.create;SecurityEvent.create=async()=>{throw new Error('audit unavailable');};try{const response=await get(`/api/security/orders/${order._id}/download/1`);assert.equal(response.status,500);assert.match(response.headers.get('content-type'),/json/);}finally{SecurityEvent.create=original;}});
test('printer link alone fails; designated OTP permits exact file and revocation stops it',async()=>{
 const invitation=await createPrinterInvitation(order,'security-print');
 const path=`/api/printer/invitations/${invitation._id}`;
 assert.equal((await fetch(base+path+'/file')).status,401);
 const challenge=await (await post(path+'/otp',{})).json();const code=otpSink.get(digest(challenge.challengeId)).code;
 const response=await post(path+'/verify',{challengeId:challenge.challengeId,code});assert.equal(response.status,200);const cookie=response.headers.get('set-cookie').split(';')[0];
 const downloaded=await fetch(base+path+'/file',{headers:{Cookie:cookie}});assert.equal(downloaded.status,200);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),pdf);
 await PrinterInvitation.updateOne({_id:invitation._id},{$set:{revokedAt:new Date()}});
 assert.equal((await fetch(base+path+'/file',{headers:{Cookie:cookie}})).status,404);
 assert.equal((await fetch(base+`/api/print-jobs/${order._id}/security-print/file?sig=old&exp=9999999999`)).status,410);
});
test('interrupted transfer has an outcome and a retry succeeds',async()=>{
 const large=Buffer.concat([pdf,Buffer.alloc(12*1024*1024,32)]);const assetId=await saveDraftPdf({originalname:'large.pdf',buffer:large},order._id,2);
 await Order.updateOne({_id:order._id},{$push:{draftVersions:{versionNumber:2,assetId}}});
 const response=await get(`/api/security/orders/${order._id}/download/2`);assert.equal(response.status,200);await response.body.cancel();
 for(let n=0;n<40&&!await SecurityEvent.exists({action:'DOWNLOAD_INTERRUPTED',version:2});n++)await new Promise(r=>setTimeout(r,25));
 assert.ok(await SecurityEvent.exists({action:'DOWNLOAD_INTERRUPTED',version:2}));
 const retry=await get(`/api/security/orders/${order._id}/download/2`);assert.equal(retry.status,200);assert.equal((await retry.arrayBuffer()).byteLength,large.length);
});
test('recent verification and account revocation are enforced on every original request',async()=>{
 const {AccessSession}=await import('../src/models/AccessSession.model.js');
 await AccessSession.updateOne({_id:digest(tokens.manager)},{$set:{verifiedAt:new Date(Date.now()-600001)}});
 const response=await get(`/api/security/orders/${order._id}/download/1`);assert.equal(response.status,403);assert.equal((await response.json()).errorCode,'OTP_REQUIRED');
 await StaffUser.updateOne({role:'admin'},{$set:{isActive:false}});
 assert.equal((await get(`/api/security/orders/${order._id}/download/1`,'admin')).status,401);
});

test('printer authorization rejects replacement, recipient change, cancellation, invitation and session expiry',async()=>{
 const {AccessSession}=await import('../src/models/AccessSession.model.js');
 const {RateLimitBucket}=await import('../src/middlewares/rateLimiter.js');
 const fresh=await Order.findById(order._id);const invitation=await createPrinterInvitation(fresh,'security-print',{reissue:true});
 const path=`/api/printer/invitations/${invitation._id}`;
 await RateLimitBucket.deleteOne({_id:`otp-send-minute:printer:${order._id}`});
 const challenge=await (await post(path+'/otp',{phone:'0712999999'})).json();const message=otpSink.get(digest(challenge.challengeId));assert.equal(message.destination,'0712000001');
 const verified=await post(path+'/verify',{challengeId:challenge.challengeId,code:message.code});const cookie=verified.headers.get('set-cookie').split(';')[0];
 const download=()=>fetch(base+path+'/file',{headers:{Cookie:cookie}});
 for(const [field,value,original] of [['printingDetails.printerPhone','0712999999',fresh.printingDetails.printerPhone],['status','cancelled',fresh.status],['printDocument.uploadedAt',new Date(0),fresh.printDocument.uploadedAt]]){
 await Order.updateOne({_id:order._id},{$set:{[field]:value}});assert.equal((await download()).status,404);await Order.updateOne({_id:order._id},{$set:{[field]:original}});
 }
 await PrinterInvitation.updateOne({_id:invitation._id},{$set:{expiresAt:new Date(0)}});assert.equal((await download()).status,404);
 await PrinterInvitation.updateOne({_id:invitation._id},{$set:{expiresAt:new Date(Date.now()+60000)}});
 await AccessSession.updateMany({kind:'printer'},{$set:{expiresAt:new Date(0)}});assert.equal((await download()).status,401);
 assert.equal((await get('/api/security/downloads','designer')).status,403);
});
