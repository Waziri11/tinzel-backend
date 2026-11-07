// Disposable acceptance server. It never loads the project's .env or customer database.
import mongoose from 'mongoose';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import bcrypt from 'bcryptjs';
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tinzel-browser-'));
process.chdir(sandbox);
for (const key of Object.keys(process.env)) {
  if (/^(SMTP_|TWILIO_|NEXTSMS_|TURNSTILE_|BLOB_|VERCEL|MONGODB_|FRONTEND_URL|BACKEND_URL|CRON_SECRET)/.test(key)) delete process.env[key];
}
process.env.NODE_ENV = 'test';
if(process.env.SECURITY_BROWSER_ORIGIN)process.env.FRONTEND_URL=process.env.SECURITY_BROWSER_ORIGIN;
process.env.SECURITY_OTP_SINK='true';
process.env.JWT_SECRET = 'isolated-browser-only-secret-never-production-2026';
process.env.DOTENV_CONFIG_PATH = path.join(sandbox, 'absent.env');
const { default: app } = await import('../src/app.js');
const { MagazineForm } = await import('../src/models/MagazineForm.model.js');
const { StaffUser } = await import('../src/models/StaffUser.model.js');
const cache = path.resolve(import.meta.dirname, '../node_modules/.cache/mongodb-memory-server');
const binaryName = fs.existsSync(cache) ? fs.readdirSync(cache).find(name => name.startsWith(`mongod-${process.arch}-${process.platform}-`)) : null;
const mongo = await MongoMemoryServer.create(binaryName ? { binary: { systemBinary: path.join(cache, binaryName) } } : {});
await mongoose.connect(mongo.getUri());
await Promise.all([StaffUser.init(), MagazineForm.init()]);
const payment = { tillNumber: 'TEST', accountName: 'Isolated test only', instructions: 'Do not pay this test order.' };
await MagazineForm.create({ title: 'Upload Performance Test', titleSw: 'Jaribio la picha', slug: 'upload-performance-test', isActive: true, price: 50000, currency: 'TZS',
  coverImageUrl: '/brand/magazine-cover-sample.jpg', sections: [{ sectionId: 'photos', title: 'Your photographs', titleSw: 'Picha zako', order: 0 }],
  fields: ['first', 'second'].map((fieldId, order) => ({ fieldId, sectionId: 'photos', type: 'photo_group', label: `${fieldId} photos`, labelSw: `Picha ${order + 1}`, order, validationRules: { maxPhotos: 100 } })), lipaNambaInstructions: payment });
const types = ['text','textarea','photo_upload','photo_group','dropdown','radio','checkbox','date','datetime','time','duration','number','linear_scale','rating','grid_radio','grid_checkbox'];
await MagazineForm.create({ title: 'Acceptance magazine', titleSw: 'Jarida la majaribio', slug: 'acceptance-magazine', isActive: true, price: 50000, currency: 'TZS',
  sections: [{sectionId:'story',title:'Your story',titleSw:'Hadithi yako',order:0}],
  fields: types.map((type, order) => ({fieldId:type,sectionId:'story',type,label:`Test ${type}`,labelSw:`Jaribio ${type}`,order,options:['One','Two'],optionsSw:['Moja','Mbili'],rows:['First','Second'],rowsSw:['Kwanza','Pili']})), lipaNambaInstructions: payment });
const passwordHash = await bcrypt.hash('Browser!2026', 10);
for (const role of ['admin','manager','designer']) await StaffUser.create({name:`Fictional ${role}`,email:`${role}@example.test`,phone:'0712000001',role,preferredLanguage:'en',passwordHash,maxActiveWorkload:20});
for (const language of ['en','sw']) await StaffUser.create({name:'Recovery fixture',email:`recovery-${language}@example.test`,phone:'0712000066',role:'designer',preferredLanguage:language,passwordHash});
await StaffUser.create({name:'Fictional onboarding',email:'onboarding@example.test',role:'designer',preferredLanguage:'en',passwordHash,mustChangePassword:true,temporaryPasswordExpiresAt:new Date(Date.now()+86400000)});
// Loopback-only test harness message sink; never mounted by the production app.
const {otpSink}=await import('../src/services/accessSessionService.js');
const {default:express}=await import('express');const testApp=express();
testApp.get('/__test__/messages',(_req,res)=>res.type('html').send('<h1>Local test messages</h1>'+[...otpSink.values()].map(m=>`<p>${m.channel} ${m.destination}: <strong>${m.code}</strong></p>`).join('')));
testApp.get('/__test__/otp/:id',async(req,res)=>{const {digest}=await import('../src/services/accessSessionService.js');const message=otpSink.get(digest(req.params.id));return message?res.json(message):res.sendStatus(404);});
testApp.post('/__test__/reset-otp-limits',async(_req,res)=>{const {RateLimitBucket}=await import('../src/middlewares/rateLimiter.js');await RateLimitBucket.deleteMany({_id:{$regex:'^otp-'}});res.json({success:true});});
const testServer=testApp.listen(Number(process.env.SECURITY_TEST_SINK_PORT||5078),'127.0.0.1');
const {Order}=await import('../src/models/Order.model.js');
const {saveDraftPdf}=await import('../src/services/draftFileService.js');
const {proofPdf}=await import('../tests/fixtures/proofPdf.js');
const {enqueueProof}=await import('../src/services/proofReaderService.js');
const form=await MagazineForm.findOne({slug:'acceptance-magazine'});
const designer=await StaffUser.findOne({role:'designer'});
for (const sequence of [9998, 9999]) await Order.create({ submissionId: `SUB-PHONE-BROWSER-${sequence}`, trackingId: `TNZ-2026-${sequence}`, clientName: 'Phone browser fixture', clientWhatsApp: '0712 000 081', formId: form._id, formTitle: 'Acceptance magazine', status: 'awaiting_payment' });
for(let n=1;n<=2;n++){
 const id=new mongoose.Types.ObjectId();const assetId=await saveDraftPdf({buffer:proofPdf(),originalname:'synthetic.pdf'},id,1);
 const order=await Order.create({_id:id,submissionId:`SUB-SECURITY-${n}`,trackingId:`TNZ-SECURITY-${n}`,clientName:`Synthetic Client ${n}`,clientWhatsApp:`071200001${n}`,formId:form._id,assignedDesigner:designer._id,status:'client_review',currentDraftVersion:1,draftVersions:[{versionNumber:1,assetId,managerReview:{status:'approved'}}]});await enqueueProof(order._id,1);
}
await StaffUser.create({name:'Unassigned designer',email:'unassigned@example.test',role:'designer',isEligibleForAssignment:false,passwordHash});
const printOrder=await Order.findOne({trackingId:'TNZ-SECURITY-2'});
printOrder.status='printing_sent';printOrder.printDocument={url:`/api/public/drafts/${printOrder.draftVersions[0].assetId}`,uploadedAt:new Date(),managerAuthorisedAt:new Date()};printOrder.printingDetails={printerPhone:'0712000099'};printOrder.workflowEvents=[{key:'synthetic-print',type:'print_dispatched'}];await printOrder.save();
// Kanban/retention acceptance fixtures use this disposable database only.
testApp.post('/__test__/kanban-fixtures', async (_req, res) => {
  const rows = Array.from({length: 12}, (_, i) => ({trackingId:`TNZ-BOARD-NEW-${String(i).padStart(2,'0')}`,status:'assigned'}));
  rows.push({trackingId:'TNZ-BOARD-MANAGER',status:'revision_requested',revisionRequests:[{roundNumber:1,draftVersionNumber:1,source:'manager',requestedBy:{type:'manager'}}]},
    {trackingId:'TNZ-BOARD-CLIENT',status:'revision_requested',revisionRequests:[{roundNumber:1,draftVersionNumber:1,source:'client',requestedBy:{type:'client'}}]},
    {trackingId:'TNZ-BOARD-DONE',status:'closed'});
  const created = [];
  for (const row of rows) created.push(await Order.create({...row,submissionId:row.trackingId,formId:form._id,formTitle:'Kanban test edition',clientName:row.trackingId,clientWhatsApp:'test',assignedDesigner:designer._id}));
  const completed = created.at(-1);
  await Order.collection.updateOne({_id:completed._id},{$set:{completedAt:new Date(Date.now()-8*86400000)}});
  res.json({completedId:String(completed._id)});
});
testApp.post('/__test__/retention-run', async (_req, res) => {
  const {cleanExpiredOrders}=await import('../src/services/orderRetentionService.js');
  const now=new Date();await cleanExpiredOrders({now});
  res.json(await cleanExpiredOrders({now:new Date(+now+6*60000)}));
});
// Consume the real protected-proof queue against this disposable database as a dedicated worker.
const {runProofJobs}=await import('../src/services/proofWorkerService.js');
let proofRun=null;
const worker=setInterval(()=>{if(!proofRun)proofRun=runProofJobs({maxJobs:6,budgetMs:10000}).catch(error=>console.error(error.code||error.name)).finally(()=>{proofRun=null;});},250);
const server = app.listen(Number(process.env.SECURITY_TEST_API_PORT||5077), '127.0.0.1');
async function stop() { testServer.close();clearInterval(worker);if(proofRun)await proofRun;server.closeAllConnections(); await new Promise(r => server.close(r)); await mongoose.disconnect(); await mongo.stop(); fs.rmSync(sandbox,{recursive:true,force:true}); process.exit(0); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
