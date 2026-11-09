import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app.js';
import { StaffUser } from '../src/models/StaffUser.model.js';
import { Order } from '../src/models/Order.model.js';
import { DraftUpload } from '../src/models/DraftUpload.model.js';
import { MagazineForm } from '../src/models/MagazineForm.model.js';
import { generateToken } from '../src/middlewares/auth.middleware.js';
import { FileUpload, FILE_CHUNK_BYTES, cleanExpiredFileUploads } from '../src/services/fileUploadService.js';
import { storeCoverImage } from '../src/services/coverStorageService.js';
import { storeOrderPhoto } from '../src/services/photoStorageService.js';
import { updateNotificationSettings } from '../src/services/notificationService.js';
let mongo, server, base, admin, designer, other, tokens, form;
const digest = b => createHash('sha256').update(b).digest('hex');
before(async () => {
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await FileUpload.init();
  await updateNotificationSettings({ channels: { sms: false, email: false, in_system: false } });
  const users = await Promise.all(['admin', 'designer', 'designer'].map((role,i) => StaffUser.create({ name: `Uploader ${i}`, email: `uploader-${i}@example.test`, role, passwordHash: 'unused' })));
  [admin,designer,other]=users;tokens=await Promise.all(users.map(u=>generateToken(u,{verifiedAt:new Date()})));
  form=await MagazineForm.create({title:'Upload fixture',slug:'upload-fixture',price:1});
  server=app.listen(0);await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{server?.closeAllConnections();await new Promise(r=>server?.close(r));await mongoose.disconnect();await mongo?.stop();});
async function call(path,body,method=body===undefined?'GET':'POST',token=tokens[0],headers={}){
  const binary=Buffer.isBuffer(body);const res=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':binary?'application/octet-stream':'application/json'}),...headers},body:body===undefined?undefined:binary?body:JSON.stringify(body)});
  return {status:res.status,data:res.headers.get('content-type')?.includes('application/json')?await res.json():Buffer.from(await res.arrayBuffer())};
}
const root='/api/staff/file-uploads';
const input=(bytes,extra={})=>({purpose:'cover',clientId:randomUUID(),fingerprint:digest(bytes),name:'photo.png',contentType:'image/png',size:bytes.length,...extra});
async function chunks(id,bytes,token=tokens[0],gzip=false){
  await Promise.all(Array.from({length:Math.ceil(bytes.length/FILE_CHUNK_BYTES)},async(_,n)=>{
    const part=bytes.subarray(n*FILE_CHUNK_BYTES,(n+1)*FILE_CHUNK_BYTES);
    const result=await call(`${root}/${id}/chunks/${n}`,gzip?gzipSync(part):part,'PUT',token,{'X-Chunk-SHA256':digest(part),...(gzip?{'Content-Encoding':'gzip'}:{})});assert.equal(result.status,200,JSON.stringify(result.data));
  }));
}
async function read(bucket,id){const bytes=[];for await(const b of new mongoose.mongo.GridFSBucket(mongoose.connection.db,{bucketName:bucket}).openDownloadStream(new mongoose.Types.ObjectId(id)))bytes.push(b);return Buffer.concat(bytes);}
test('covers larger than the old gateway cap upload in parallel and retain exact PNG bytes',async()=>{
  const bytes=await sharp(randomBytes(1400*1200*3),{raw:{width:1400,height:1200,channels:3}}).png().toBuffer();assert.ok(bytes.length>4*1024*1024);
  const body=input(bytes),reserved=await call(root,body);assert.equal(reserved.status,201);const id=reserved.data.id;
  assert.equal((await call(`${root}/${id}/complete`,{})).status,409);
  await chunks(id,bytes);assert.equal((await call(root,body)).data.chunks.length,Math.ceil(bytes.length/FILE_CHUNK_BYTES));
  const complete=await call(`${root}/${id}/complete`,{});assert.equal(complete.status,200);assert.equal((await call(`${root}/${id}/complete`,{})).data.coverUrl,complete.data.coverUrl);
  const loaded=await call(complete.data.coverUrl);assert.deepEqual(loaded.data,bytes);
  const denied=await call(root,input(bytes), 'POST',tokens[1]);assert.equal(denied.status,403);
  assert.equal((await call(`${root}/${id}`,undefined,'GET',tokens[1])).status,404);
});
test('gzip PDF parts retain bytes, enforce hashes and assignment, and can be attached as print files',async()=>{
  const order=await Order.create({submissionId:randomUUID(),formId:form._id,clientName:'Fixture',clientWhatsApp:'fixture-no-contact',assignedDesigner:designer._id,status:'client_approved'});
  const bytes=Buffer.concat([Buffer.from('%PDF-1.7\n'),Buffer.alloc(6*1024*1024,32),Buffer.from('\n%%EOF')]);
  const body=input(bytes,{purpose:'print',orderId:String(order._id),name:'print.pdf',contentType:'application/pdf'});
  assert.equal((await call(root,body,'POST',tokens[2])).status,403);
  const reserved=await call(root,body,'POST',tokens[1]);assert.equal(reserved.status,201);const id=reserved.data.id;
  assert.equal((await call(`${root}/${id}/chunks/0`,bytes.subarray(0,FILE_CHUNK_BYTES),'PUT',tokens[1],{'X-Chunk-SHA256':'0'.repeat(64)})).status,409);
  await chunks(id,bytes,tokens[1],true);
  const conflict=Buffer.alloc(FILE_CHUNK_BYTES,42);assert.equal((await call(`${root}/${id}/chunks/1`,conflict,'PUT',tokens[1],{'X-Chunk-SHA256':digest(conflict)})).status,409);
  assert.equal((await call(`${root}/${id}/complete`,{},'POST',tokens[1])).status,200);
  const stored=await FileUpload.findById(id);assert.deepEqual(await read('draftFiles',stored.assetId),bytes);
  const result=await call(`/api/designer/orders/${order._id}/upload-print-document`,{fileUploadId:id,quantity:2},'POST',tokens[1]);assert.equal(result.status,200,JSON.stringify(result.data));
  const saved=await Order.findById(order._id);assert.equal(saved.printDocument.url,`/api/public/drafts/${stored.assetId}`);
});
test('compressed payloads cannot exceed the expanded part limit; expired incomplete uploads are reclaimed',async()=>{
  const bytes=Buffer.alloc(FILE_CHUNK_BYTES+1,32),reserve=await call(root,input(bytes));const id=reserve.data.id;
  assert.equal((await call(`${root}/${id}/chunks/0`,gzipSync(bytes),'PUT',tokens[0],{'Content-Encoding':'gzip','X-Chunk-SHA256':digest(bytes)})).status,413);
  await chunks(id,bytes);await FileUpload.updateOne({_id:id},{$set:{expiresAt:new Date(0)}});await cleanExpiredFileUploads();assert.equal(await FileUpload.findById(id),null);
});
test('legacy cover and order-photo storage preserve JPEG, PNG and WebP originals including metadata',async()=>{
  for(const type of ['jpeg','png','webp']){
    const bytes=await sharp({create:{width:200,height:150,channels:4,background:'#aabbcc80'}}).withMetadata({orientation:6})[type]().toBuffer();const file={buffer:bytes,mimetype:`image/${type}`,originalname:`photo.${type}`,size:bytes.length};
    const cover=await storeCoverImage(file,admin._id),photo=await storeOrderPhoto(file);
    assert.deepEqual(await read('coverImages',cover.id),bytes);assert.deepEqual(await read('orderPhotos',photo.id),bytes);
  }
});
test('single-request covers are lossless, idempotent, size bounded and permission checked', async () => {
  const bytes = await sharp(randomBytes(900*700*3), {raw:{width:900,height:700,channels:3}}).png().toBuffer();
  const body = input(bytes,{chunkBytes:FILE_CHUNK_BYTES/2}), headers = {'X-Upload-Metadata':encodeURIComponent(JSON.stringify(body)), 'X-Chunk-SHA256':digest(bytes)};
  const first = await call(`${root}/whole`, bytes, 'PUT', tokens[0], headers); assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual((await call(first.data.coverUrl)).data, bytes);
  assert.equal((await call(`${root}/${first.data.id}`)).data.chunkBytes,FILE_CHUNK_BYTES/2);
  assert.deepEqual((await call(`${root}/whole`, bytes, 'PUT', tokens[0], headers)).data, first.data);
  assert.equal(await FileUpload.countDocuments({staffId:admin._id,clientId:body.clientId}), 1);
  assert.equal((await call(`${root}/whole`, bytes, 'PUT', tokens[1], headers)).status, 403);
  assert.equal((await call(`${root}/whole`, bytes, 'PUT', tokens[0], {...headers,'X-Chunk-SHA256':'0'.repeat(64)})).status, 409);
  assert.equal((await call(`${root}/whole`, bytes, 'PUT', tokens[0], {...headers,'X-Upload-Metadata':'invalid'})).status, 400);
  const oversized = Buffer.alloc(3*FILE_CHUNK_BYTES+1);
  assert.equal((await call(`${root}/whole`, gzipSync(oversized), 'PUT', tokens[0], {...headers,'Content-Encoding':'gzip'})).status, 413);
});
test('batched print uploads resume individual parts, reject corrupt batches and preserve original bytes', async () => {
  const order=await Order.create({submissionId:randomUUID(),formId:form._id,clientName:'Batch fixture',clientWhatsApp:'fixture-no-contact',assignedDesigner:designer._id,status:'client_approved'});
  const bytes=Buffer.concat([Buffer.from('%PDF-1.7\n'),randomBytes(5*FILE_CHUNK_BYTES)]);
  const reserved=await call(root,input(bytes,{purpose:'print',orderId:String(order._id),name:'print.pdf',contentType:'application/pdf'}),'POST',tokens[1]);
  const id=reserved.data.id; assert.equal(reserved.data.batchParts,3);
  const batch=bytes.subarray(0,3*FILE_CHUNK_BYTES);
  assert.equal((await call(`${root}/${id}/batches/0`,batch,'PUT',tokens[1],{'X-Chunk-SHA256':'0'.repeat(64)})).status,409);
  assert.equal((await call(`${root}/${id}` ,undefined,'GET',tokens[1])).data.chunks.length,0);
  assert.equal((await call(`${root}/${id}/batches/0`,batch,'PUT',tokens[1],{'X-Chunk-SHA256':digest(batch)})).status,200);
  assert.equal((await call(`${root}/${id}`,undefined,'GET',tokens[1])).data.chunks.length,3);
  // Retry a saved part individually, then finish the remaining batch.
  const part=bytes.subarray(0,FILE_CHUNK_BYTES);
  assert.equal((await call(`${root}/${id}/chunks/0`,part,'PUT',tokens[1],{'X-Chunk-SHA256':digest(part)})).status,200);
  const rest=bytes.subarray(3*FILE_CHUNK_BYTES);
  assert.equal((await call(`${root}/${id}/batches/3`,gzipSync(rest),'PUT',tokens[1],{'Content-Encoding':'gzip','X-Chunk-SHA256':digest(rest)})).status,200);
  assert.equal((await call(`${root}/${id}/complete`,{},'POST',tokens[1])).status,200);
  assert.deepEqual(await read('draftFiles',(await FileUpload.findById(id)).assetId),bytes);
});
test('small PDF transfer prepares review without submitting, and larger PDFs support verified batches', async () => {
  for (const size of [2*FILE_CHUNK_BYTES+17,7*FILE_CHUNK_BYTES+17]) {
    const order=await Order.create({submissionId:randomUUID(),formId:form._id,clientName:'Draft fixture',clientWhatsApp:'fixture-no-contact',assignedDesigner:designer._id,status:'in_design'});
    const bytes=Buffer.concat([Buffer.from('%PDF-1.7\n'),Buffer.alloc(size-9,32)]),prefix=`/api/designer/orders/${order._id}/draft-uploads`;
    const reserved=await call(prefix,{name:'draft.pdf',contentType:'application/pdf',size:bytes.length,chunkBytes:size<3*FILE_CHUNK_BYTES?FILE_CHUNK_BYTES/2:FILE_CHUNK_BYTES,fingerprint:digest(bytes),expectedVersion:0},'POST',tokens[1]);
    assert.equal(reserved.data.batchParts,3);const id=reserved.data.id;
    if(size<3*FILE_CHUNK_BYTES){
      for(let attempt=0;attempt<2;attempt++)assert.equal((await call(`${prefix}/${id}/whole`,gzipSync(bytes),'PUT',tokens[1],{'Content-Encoding':'gzip','X-Chunk-SHA256':digest(bytes)})).status,200);
    }else{
      for(let n=0;n<Math.ceil(size/FILE_CHUNK_BYTES);n+=3){const batch=bytes.subarray(n*FILE_CHUNK_BYTES,(n+3)*FILE_CHUNK_BYTES);assert.equal((await call(`${prefix}/${id}/batches/${n}`,gzipSync(batch),'PUT',tokens[1],{'Content-Encoding':'gzip','X-Chunk-SHA256':digest(batch)})).status,200);}
      assert.equal((await call(`${prefix}/${id}/ready`,{},'POST',tokens[1])).status,200);
    }
    const saved=await DraftUpload.findById(id);assert.equal(saved.readyForReview,true);assert.deepEqual(await read('draftFiles',saved.assetId),bytes);
    const unchanged=await Order.findById(order._id);assert.equal(unchanged.status,'in_design');assert.equal(unchanged.draftVersions.length,0);
  }
});
