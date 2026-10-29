import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp,open,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app.js';
import { Order } from '../src/models/Order.model.js';
import { StaffUser } from '../src/models/StaffUser.model.js';
import { MagazineForm } from '../src/models/MagazineForm.model.js';
import { DraftUpload } from '../src/models/DraftUpload.model.js';
import { MediaJob,ProofPage } from '../src/models/Media.model.js';
import { generateToken } from '../src/middlewares/auth.middleware.js';
import { updateNotificationSettings } from '../src/services/notificationService.js';
import { cleanExpiredDraftUploads, DRAFT_CHUNK_BYTES,MAX_DRAFT_BYTES } from '../src/services/draftUploadService.js';
import { openPrivatePdf,requestProofBatch } from '../src/services/proofReaderService.js';
import { runMediaJobs } from '../src/services/mediaJobService.js';
import { proofPdf } from './fixtures/proofPdf.js';
let mongo,server,base,designer,token,form,folder;
const digest=(b)=>createHash('sha256').update(b).digest('hex');
before(async()=>{
  mongo=await MongoMemoryServer.create();await mongoose.connect(mongo.getUri());await ProofPage.init();
  await updateNotificationSettings({channels:{email:false,sms:false,in_system:false}});
  designer=await StaffUser.create({name:'Draft tester',email:'draft@example.test',role:'designer',passwordHash:'unused'});token=generateToken(designer);
  form=await MagazineForm.create({title:'Draft upload',slug:'draft-upload',price:1});
  const gateway=express();gateway.use((req,res,next)=>Number(req.headers['content-length'])>4.5*1024*1024?res.status(413).json({code:'FUNCTION_PAYLOAD_TOO_LARGE'}):next());gateway.use(app);
  server=gateway.listen(0);await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
  folder=await mkdtemp(path.join(tmpdir(),'tinzel-large-'));
});
after(async()=>{server?.closeAllConnections();await new Promise(r=>server?.close(r));await mongoose.disconnect();await mongo?.stop();await rm(folder,{recursive:true,force:true});});
async function newOrder(){return Order.create({submissionId:`SUB-${new mongoose.Types.ObjectId()}`,formId:form._id,clientName:'Draft client',clientWhatsApp:'0712000000',assignedDesigner:designer._id,status:'in_design'});}
async function request(order,suffix='',body,method=body===undefined?'GET':'POST',auth=token,headers={}){
  const binary=Buffer.isBuffer(body);
  const res=await fetch(`${base}/api/designer/orders/${order._id}/draft-uploads${suffix}`,{method,headers:{Authorization:`Bearer ${auth}`,...(body!==undefined?{'Content-Type':binary?'application/octet-stream':'application/json'}:{}),...headers},body:body===undefined?undefined:binary?body:JSON.stringify(body)});
  return {status:res.status,data:await res.json()};
}
const input=(size)=>({name:'large.pdf',size,contentType:'application/pdf',fingerprint:'a'.repeat(64),expectedVersion:0,designerNotes:'Large proof'});
async function part(order,session,n,bytes){return request(order,`/${session.id}/chunks/${n}`,bytes,'PUT',token,{'X-Chunk-SHA256':digest(bytes)});}
async function sparsePdf(size){
  const bytes=proofPdf(12),cut=bytes.indexOf(Buffer.from('\nxref\n'))+1,head=bytes.subarray(0,cut);
  const original=bytes.subarray(cut).toString(),count=Number(original.match(/xref\n0 (\d+)/)[1]);
  let tail=original.replace(`xref\n0 ${count}\n`,`xref\n0 ${count+1}\n`).replace('trailer\n',`${String(head.length).padStart(10,'0')} 00000 n \ntrailer\n`).replace(`/Size ${count}`,`/Size ${count+1}`);
  const ending=Buffer.from('\nendstream\nendobj\n');let header='';
  for(let i=0;i<5;i++){
    tail=tail.replace(/startxref\n\d+/,`startxref\n${size-Buffer.byteLength(tail)}`);
    header=`${count} 0 obj\n<< /Length ${size-head.length-Buffer.byteLength(header)-ending.length-Buffer.byteLength(tail)} >>\nstream\n`;
  }
  const file=await open(path.join(folder,`${size}.pdf`),'w+');await file.write(head,0,head.length,0);
  await file.write(Buffer.from(header),0,Buffer.byteLength(header),head.length);
  await file.write(ending,0,ending.length,size-Buffer.byteLength(tail)-ending.length);
  await file.write(Buffer.from(tail),0,Buffer.byteLength(tail),size-Buffer.byteLength(tail));return file;
}
for(const size of [120*1024*1024,MAX_DRAFT_BYTES])test(`valid ${size/1024/1024} MB PDF transfers through a 4.5 MB gateway and renders by ranges`,{timeout:180000},async()=>{
  const order=await newOrder(),file=await sparsePdf(size),started=performance.now();let peak=process.memoryUsage().rss;
  try{
    const created=await request(order,'',input(size));assert.equal(created.status,201,JSON.stringify(created.data));const session=created.data;
    const buffer=Buffer.alloc(DRAFT_CHUNK_BYTES);
    for(let n=0;n<Math.ceil(size/DRAFT_CHUNK_BYTES);n++){
      const length=Math.min(DRAFT_CHUNK_BYTES,size-n*DRAFT_CHUNK_BYTES);await file.read(buffer,0,length,n*DRAFT_CHUNK_BYTES);
      assert.equal((await part(order,session,n,buffer.subarray(0,length))).status,200);peak=Math.max(peak,process.memoryUsage().rss);
      if(n===2){assert.equal((await part(order,session,n,buffer.subarray(0,length))).status,200);assert.equal((await request(order,`/${session.id}`)).data.chunks.length,3);}
    }
    const results=await Promise.all([request(order,`/${session.id}/complete`,{}),request(order,`/${session.id}/complete`,{})]);assert.ok(results.some(r=>r.status===200));assert.ok(results.every(r=>[200,409].includes(r.status)));
    const replay=await request(order,`/${session.id}/complete`,{});assert.equal(replay.status,200);assert.equal(replay.data.order.draftVersions.length,1);assert.equal(replay.data.order.draftVersions[0].size,size);
    const persisted=await Order.findById(order._id);const pdf=await openPrivatePdf(persisted.draftVersions[0],AbortSignal.timeout(30000));
    assert.equal(pdf.numPages,12);await pdf.getPage(1);const read=pdf.proofBytesRead();assert.ok(read<3*1024*1024,`Range parser read ${read} bytes`);await pdf.destroy();
    const proof=`${base}/api/proofs/staff/${order._id}/1`;
    const prepare=await fetch(proof+'/prepare',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({pages:[1]})});const ready=await prepare.json();assert.equal(prepare.status,200,JSON.stringify(ready));assert.equal(ready.opening.ready,5);
    assert.equal(await MediaJob.countDocuments({orderId:order._id,page:{$gt:5}}),0);
    const later=await fetch(proof+'/prepare',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({pages:[10,11]})});const laterData=await later.json();assert.equal(later.status,200);if(laterData.pages.length<12)await runMediaJobs({maxJobs:6,proofFilter:{orderId:order._id,version:1}});
    assert.equal(await ProofPage.countDocuments({orderId:order._id,page:{$in:[10,11,12]}}),3);
    console.info(JSON.stringify({event:'large_draft_validation',sizeBytes:size,durationMs:Math.round(performance.now()-started),peakRssBytes:peak,parserBytesRead:read}));
  }finally{await file.close();}
});
test('sessions enforce assignment, integrity, cancellation, expiry, incomplete parts and stale versions',async()=>{
  const order=await newOrder(),bytes=proofPdf();
  assert.equal((await request(order,'',input(MAX_DRAFT_BYTES+1))).status,413);
  const other=await StaffUser.create({name:'Other designer',email:'otherdraft@example.test',role:'designer',passwordHash:'unused'});
  assert.equal((await request(order,'',input(bytes.length),'POST',generateToken(other))).status,403);
  const manager=await StaffUser.create({name:'Manager',email:'draftmanager@example.test',role:'manager',passwordHash:'unused'});
  assert.equal((await request(order,'',input(bytes.length),'POST',generateToken(manager))).status,403);
  const session=(await request(order,'',input(bytes.length))).data;
  assert.equal((await request(order,`/${session.id}/complete`,{})).status,409);
  assert.equal((await request(order,`/${session.id}/chunks/0`,bytes,'PUT',token,{'X-Chunk-SHA256':'0'.repeat(64)})).status,409);
  assert.equal((await part(order,session,0,bytes)).status,200);
  assert.equal((await part(order,session,0,Buffer.from(bytes.toString().replace('Magazine','Changed!')))).status,409);
  await Order.updateOne({_id:order._id},{$set:{currentDraftVersion:1}});
  assert.equal((await request(order,`/${session.id}/complete`,{})).status,409);
  assert.equal((await request(order,`/${session.id}`,undefined,'DELETE')).status,200);
  assert.equal((await request(order,`/${session.id}`)).status,410);
  const storedSession=await DraftUpload.findById(session.id);
  await cleanExpiredDraftUploads();assert.equal(await DraftUpload.findById(session.id),null);
  assert.equal(await mongoose.connection.db.collection('draftFiles.chunks').countDocuments({files_id:storedSession.assetId}),0);
});

async function imageProofFile(size){
  const file=await open(path.join(folder,'image-proof.pdf'),'w+');let position=0;const offsets=[0],pages=20,width=1296,height=1296;
  const write=async(value)=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(value);await file.write(bytes,0,bytes.length,position);position+=bytes.length;};
  const object=async(number,body)=>{offsets[number]=position;await write(`${number} 0 obj\n${body}\nendobj\n`);};
  await write('%PDF-1.7\n');await object(1,'<< /Type /Catalog /Pages 2 0 R >>');
  await object(2,`<< /Type /Pages /Count ${pages} /Kids [${Array.from({length:pages},(_,i)=>`${3+i*3} 0 R`).join(' ')}] >>`);
  const image=randomBytes(width*height*3);
  for(let i=0;i<pages;i++){
    const page=3+i*3,content=page+1,asset=page+2;
    await object(page,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 648 648] /Resources << /XObject << /Im0 ${asset} 0 R >> >> /Contents ${content} 0 R >>`);
    const commands='q 648 0 0 648 0 0 cm /Im0 Do Q';await object(content,`<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`);
    offsets[asset]=position;await write(`${asset} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.length} >>\nstream\n`);await write(image);await write('\nendstream\nendobj\n');
  }
  const extra=3+pages*3;offsets[extra]=position;
  let tail=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`+offsets.slice(1).map(o=>`${String(o).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n0\n%%EOF`;
  const end=Buffer.from('\nendstream\nendobj\n');let header='';
  for(let i=0;i<5;i++){tail=tail.replace(/startxref\n\d+/,`startxref\n${size-Buffer.byteLength(tail)}`);header=`${extra} 0 obj\n<< /Length ${size-position-Buffer.byteLength(header)-end.length-Buffer.byteLength(tail)} >>\nstream\n`;}
  await write(header);await file.write(end,0,end.length,size-Buffer.byteLength(tail)-end.length);await file.write(Buffer.from(tail),0,Buffer.byteLength(tail),size-Buffer.byteLength(tail));return file;
}
test('image-heavy 120 MB proof opens five pages without preparing the remaining fifteen',{timeout:180000},async()=>{
  const size=120*1024*1024,order=await newOrder(),file=await imageProofFile(size);let peak=process.memoryUsage().rss;
  const monitor=setInterval(()=>peak=Math.max(peak,process.memoryUsage().rss),20);
  try{
    const session=(await request(order,'',input(size))).data;const buffer=Buffer.alloc(DRAFT_CHUNK_BYTES);
    for(let n=0;n<Math.ceil(size/DRAFT_CHUNK_BYTES);n++){const length=Math.min(buffer.length,size-n*buffer.length);await file.read(buffer,0,length,n*buffer.length);assert.equal((await part(order,session,n,buffer.subarray(0,length))).status,200);}
    assert.equal((await request(order,`/${session.id}/complete`,{})).status,200);
    const stored=await Order.findById(order._id),pdf=await openPrivatePdf(stored.draftVersions[0],AbortSignal.timeout(30000));assert.equal(pdf.numPages,20);await pdf.destroy();
    const started=performance.now();await requestProofBatch(order._id,1,[1]);await runMediaJobs({maxJobs:6,proofFilter:{orderId:order._id,version:1}});
    const prepared=await ProofPage.find({orderId:order._id,page:{$gt:0}}).lean();assert.equal(prepared.length,5,JSON.stringify(await MediaJob.find({orderId:order._id}).select('error state')));
    assert.equal(await MediaJob.countDocuments({orderId:order._id,page:{$gt:5}}),0);
    console.info(JSON.stringify({event:'image_heavy_proof_validation',sizeBytes:size,renderDurationMs:Math.round(performance.now()-started),peakRssBytes:peak,preparedPages:5,totalPages:20}));
  }finally{clearInterval(monitor);await file.close();}
});

test('gateway rejects a large single request and expired sessions reject further parts',async()=>{
  const order=await newOrder();
  const gateway=await request(order,'',Buffer.alloc(5*1024*1024));assert.equal(gateway.status,413);assert.equal(gateway.data.code,'FUNCTION_PAYLOAD_TOO_LARGE');
  const session=(await request(order,'',input(proofPdf().length))).data;
  await DraftUpload.updateOne({_id:session.id},{$set:{expiresAt:new Date(Date.now()-1000)}});
  assert.equal((await request(order,`/${session.id}`)).status,410);
  assert.equal((await part(order,session,0,proofPdf())).status,410);
  await cleanExpiredDraftUploads();assert.equal(await DraftUpload.findById(session.id),null);
});
test('correction completion is checked when creating and committing a session',async()=>{
  const order=await newOrder();
  order.status='revision_requested';order.revisionRequests.push({roundNumber:1,draftVersionNumber:0,source:'manager',requestedBy:{type:'manager',name:'Manager'},items:[{text:'Replace cover',status:'open'}]});await order.save();
  const round=order.revisionRequests[0],metadata={...input(proofPdf().length),revisionRequestId:String(round._id),verifyAll:true};
  assert.equal((await request(order,'',metadata)).status,409);
  round.items[0].status='addressed';await order.save();const created=await request(order,'',metadata);assert.equal(created.status,201);
  assert.equal((await part(order,created.data,0,proofPdf())).status,200);
  round.items[0].status='open';await order.save();const commit=await request(order,`/${created.data.id}/complete`,{});assert.equal(commit.status,409);assert.match(commit.data.message,/verify every/);
  assert.equal((await Order.findById(order._id)).draftVersions.length,0);
});
