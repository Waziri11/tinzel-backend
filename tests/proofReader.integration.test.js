import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app.js';
import { Order } from '../src/models/Order.model.js';
import { MagazineForm } from '../src/models/MagazineForm.model.js';
import { StaffUser } from '../src/models/StaffUser.model.js';
import { MediaJob, ProofPage } from '../src/models/Media.model.js';
import { generateToken, generateClientToken } from '../src/middlewares/auth.middleware.js';
import { runMediaJobs } from '../src/services/mediaJobService.js';
import { updateNotificationSettings } from '../src/services/notificationService.js';
import { proofPdf } from './fixtures/proofPdf.js';
let mongo, server, base, order, tokens={};
before(async()=>{
  mongo=await MongoMemoryServer.create();await mongoose.connect(mongo.getUri());await ProofPage.init();
  await updateNotificationSettings({ channels:{sms:false,email:false,in_system:false} });
  for(const role of ['designer','manager','admin']) {const user=await StaffUser.create({name:`Test ${role}`,email:`${role}@example.test`,role,passwordHash:'unused',isActive:true});tokens[role]=generateToken(user);tokens[role+'Id']=user._id;}
  const form=await MagazineForm.create({title:'Proof test',slug:'proof-reader-test',price:100});
  order=await Order.create({submissionId:'SUB-PROOF',trackingId:'TNZ-PROOF',formId:form._id,clientName:'Test client',clientWhatsApp:'0712000000',assignedDesigner:tokens.designerId,status:'in_design'});
  tokens.client=generateClientToken(order);
  server=app.listen(0);await new Promise((r)=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{server?.closeAllConnections();await new Promise((r)=>server?.close(r));await mongoose.disconnect();await mongo?.stop();});
async function request(path,role='manager',body,method=body===undefined?'GET':'POST') {
  const response=await fetch(base+path,{method,headers:{Authorization:`Bearer ${tokens[role]}`,...(body instanceof FormData?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});
  return {status:response.status,data:await response.json(),headers:response.headers};
}
const path=(role='staff',version=1)=>`/api/proofs/${role==='client'?'client':`staff/${order._id}`}/${version}`;
async function upload(version,extra={}) {
  const body=new FormData();body.append('draftFile',new Blob([proofPdf()],{type:'application/pdf'}),'proof.pdf');body.append('expectedVersion',String(version));for(const [k,v]of Object.entries(extra))body.append(k,v);
  return request(`/api/designer/orders/${order._id}/upload-draft`,'designer',body);
}
const annotation={page:1,kind:'text',rects:[{x:.1,y:.2,width:.3,height:.1}],selectedText:'Magazine',text:'Correct this heading'};
test('protected magazine review completes upload, render, manager and client corrections, replacement, and history',async()=>{
  assert.equal((await upload(0)).status,200);
  const original=await request(`/api/designer/orders/${order._id}`,'designer');
  assert.equal(original.data.order.draftVersions[0].assetId,undefined);
  assert.equal(original.data.order.proofAnnotations,undefined);
  assert.equal((await request(path('client'),'client')).status,404);
  assert.equal((await request(path())).status,200);
  await runMediaJobs({maxJobs:5});
  const metadata=await request(path());assert.equal(metadata.data.pageCount,2,JSON.stringify(await MediaJob.find({kind:'proof'}).select('state error').lean()));assert.equal(metadata.data.pages.length,2);assert.equal(metadata.data.canComment,true);
  const positions=await request(path()+'/pages/1?text=1');assert.match(positions.data.text[0].str,/Magazine/);
  const rotated=await request(path()+'/pages/2?text=1');assert.ok(rotated.data.height>rotated.data.width);
  const page=await fetch(base+path()+'/pages/1',{headers:{Authorization:`Bearer ${tokens.manager}`}});assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/image\/webp/);assert.match(page.headers.get('cache-control'),/no-store/);const image=Buffer.from(await page.arrayBuffer());assert.ok(image.length>1000);
  const adminPage=await fetch(base+path()+'/pages/1',{headers:{Authorization:`Bearer ${tokens.admin}`}});assert.notDeepEqual(Buffer.from(await adminPage.arrayBuffer()),image);
  const bundleUrl=base+path()+'/pages/1?bundle=1&view=reader-session-test';
  const bundle=await fetch(bundleUrl,{headers:{Authorization:`Bearer ${tokens.manager}`}});assert.equal(bundle.status,200);assert.match(bundle.headers.get('content-type'),/application\/vnd.tinzel.proof-page/);assert.match(bundle.headers.get('cache-control'),/no-store/);
  const packed=Buffer.from(await bundle.arrayBuffer()),length=packed.readUInt32BE(0),geometry=JSON.parse(packed.subarray(4,4+length));assert.match(geometry.text[0].str,/Magazine/);assert.ok(packed.length>length+1000);
  const cached=await fetch(bundleUrl,{headers:{Authorization:`Bearer ${tokens.manager}`}});assert.deepEqual(Buffer.from(await cached.arrayBuffer()),packed);
  const isolated=await fetch(bundleUrl,{headers:{Authorization:`Bearer ${tokens.admin}`}});assert.notDeepEqual(Buffer.from(await isolated.arrayBuffer()),packed);
  assert.equal((await request(path()+'/diagnostics','designer')).status,403);assert.equal((await request(path()+'/diagnostics','manager')).status,200);

  for(const role of ['designer','manager','admin']) for(const suffix of ['view','download']) assert.equal((await request(`/api/designer/orders/${order._id}/drafts/1/${suffix}`,role)).status,403);
  assert.equal((await request('/api/client/draft/view','client')).status,404);
  assert.equal((await fetch(base+'/uploads/drafts/legacy.pdf')).status,404);
  assert.equal((await request(path(),'designer',annotation)).status,404);
  assert.equal((await request(path()+'/annotations','designer',annotation)).status,403);
  assert.equal((await request(path()+'/annotations','manager',{...annotation,rects:[{x:2,y:0,width:.1,height:.1}]})).status,400);
  const saved=await request(path()+'/annotations','manager',annotation);assert.equal(saved.status,200);const id=saved.data.annotations[0]._id;
  assert.equal((await request(path(),'designer')).data.annotations.length,0);
  assert.equal((await request(path())).data.annotations.length,1);
  assert.equal((await request(`/api/manager/orders/${order._id}/review-draft`,'manager',{action:'release_to_client',expectedVersion:1})).status,409);
  const returned=await request(`/api/manager/orders/${order._id}/review-draft`,'manager',{action:'return_to_designer',items:[],expectedVersion:1});assert.equal(returned.status,200,JSON.stringify(returned.data));
  const round=returned.data.order.revisionRequests[0];assert.equal(round.items[0].annotationId,id);
  assert.equal((await request(path(),'designer')).data.annotations.length,1);
  assert.equal((await request(path()+`/annotations/${id}`,'manager',undefined,'DELETE')).status,403);
  assert.equal((await upload(1,{revisionRequestId:round._id,verifyAll:'true'})).status,400);
  assert.equal((await request(`/api/designer/orders/${order._id}/returns/${round._id}/items/${round.items[0]._id}`,'designer',{response:'Corrected'},'PATCH')).status,200);
  assert.equal((await upload(1,{revisionRequestId:round._id,verifyAll:'true'})).status,200);
  assert.equal((await request(`/api/manager/orders/${order._id}/review-draft`,'manager',{action:'release_to_client',expectedVersion:1})).status,409);
  assert.equal((await request(`/api/manager/orders/${order._id}/review-draft`,'manager',{action:'release_to_client',expectedVersion:2})).status,200);
  assert.equal((await request(path('client',2),'client')).status,200);await runMediaJobs({maxJobs:5});
  assert.equal((await request('/api/client/draft/view','client')).status,403);
  const clientComment=await request(path('client',2)+'/annotations','client',{...annotation,kind:'area',selectedText:'',text:'Replace photograph'});assert.equal(clientComment.status,200);
  assert.equal((await request(path('staff',2))).data.annotations.length,0);
  assert.equal((await request('/api/client/approve-draft','client',{expectedVersion:2})).status,409);
  const clientReturn=await request('/api/client/request-revision','client',{expectedVersion:2,items:[]});assert.equal(clientReturn.status,200);const clientRound=clientReturn.data.order.revisionRequests.at(-1);
  assert.equal((await request('/api/client/request-revision','client',{expectedVersion:2,items:[]})).status,400);
  await request(`/api/designer/orders/${order._id}/returns/${clientRound._id}/items/${clientRound.items[0]._id}`,'designer',{response:'Photograph replaced'},'PATCH');
  assert.equal((await upload(2,{revisionRequestId:clientRound._id,verifyAll:'true'})).status,200);
  assert.equal((await request(path('client',2),'client')).status,200);
  assert.equal((await request(path('client',3),'client')).status,404);
  const historical = await request('/api/client/order','client');
  assert.deepEqual(historical.data.order.draftVersions.map((v)=>v.versionNumber),[2]);
  assert.equal((await request(`/api/manager/orders/${order._id}/review-draft`,'manager',{action:'release_to_client',expectedVersion:3})).status,200);
  assert.equal((await request('/api/client/approve-draft','client',{expectedVersion:3})).status,200);
  assert.equal((await request(path('staff',3))).data.annotations.length,0);
});

test('reader checks authentication, assignment, immutable historical annotations, and preparation retry',async()=>{
  assert.equal((await fetch(base+path())).status,401);
  const other=await StaffUser.create({name:'Other',email:'other@example.test',role:'designer',passwordHash:'unused'});tokens.other=generateToken(other);
  assert.equal((await request(path(),'other')).status,403);
  await MediaJob.updateOne({_id:`proof:${order._id}:1:0`},{$set:{state:'failed',attempts:3}});
  const reopened=(await request(path())).data;assert.equal(reopened.state,'ready');assert.equal(reopened.coverReady,true);assert.equal(reopened.diagnostics.length,1);
  assert.equal((await request(path()+'/retry','manager',{})).status,200);
  assert.equal((await MediaJob.findById(`proof:${order._id}:1:0`)).state,'queued');
  const record=await Order.findById(order._id);const a=record.proofAnnotations[0];assert.equal((await request(path()+`/annotations/${a._id}`,'manager',undefined,'DELETE')).status,403);
});
