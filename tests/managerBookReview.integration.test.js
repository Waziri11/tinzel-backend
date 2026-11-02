import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {MongoMemoryServer} from 'mongodb-memory-server';
import app from '../src/app.js';
import {Order} from '../src/models/Order.model.js';
import {StaffUser} from '../src/models/StaffUser.model.js';
import {MagazineForm} from '../src/models/MagazineForm.model.js';
import {AuditLog} from '../src/models/AuditLog.model.js';
import {ProofPage} from '../src/models/Media.model.js';
import {generateToken,generateClientToken} from '../src/middlewares/auth.middleware.js';
import {updateNotificationSettings} from '../src/services/notificationService.js';
import {runMediaJobs} from '../src/services/mediaJobService.js';
import {proofPdf} from './fixtures/proofPdf.js';
let mongo,server,base,form,designer,tokens={};
before(async()=>{
 mongo=await MongoMemoryServer.create();await mongoose.connect(mongo.getUri());await ProofPage.init();await updateNotificationSettings({channels:{in_system:false,email:false,sms:false}});
 for(const role of ['manager','designer','admin']){const user=await StaffUser.create({name:`Review ${role}`,email:`review-${role}@example.test`,role,passwordHash:'unused'});tokens[role]=generateToken(user);if(role==='designer')designer=user;}
 form=await MagazineForm.create({title:'Manager book review',slug:'manager-book-review',price:100});server=app.listen(0);await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await mongoose.disconnect();await mongo.stop();});
async function req(path,body,role='manager',method=body===undefined?'GET':'POST') {const response=await fetch(base+path,{method,headers:{Authorization:`Bearer ${tokens[role]}`,...(body instanceof FormData?{}:{'Content-Type':'application/json'})},...(body!==undefined?{body:body instanceof FormData?body:JSON.stringify(body)}:{})});return{status:response.status,data:await response.json()};}
async function upload(order,expected,extra={}){const data=new FormData();data.append('draftFile',new Blob([proofPdf(3)],{type:'application/pdf'}),'magazine.pdf');data.append('expectedVersion',String(expected));for(const[k,v]of Object.entries(extra))data.append(k,v);return req(`/api/designer/orders/${order._id}/upload-draft`,data,'designer');}
async function createOrder(){const id=new mongoose.Types.ObjectId();const order=await Order.create({_id:id,submissionId:`SUB-BOOK-${id}`,trackingId:`TNZ-BOOK-${id}`,formId:form._id,assignedDesigner:designer._id,clientName:'Book review client',clientWhatsApp:'0712000001',status:'in_design'});assert.equal((await upload(order,0)).status,200);await runMediaJobs({maxJobs:10});return order;}
const proof=(order,version=1)=>`/api/proofs/staff/${order._id}/${version}`;
const review=(order)=>`/api/manager/orders/${order._id}/review-draft`;
async function address(order,round){for(const item of round.items)assert.equal((await req(`/api/designer/orders/${order._id}/returns/${round._id}/items/${item._id}`,{response:'Corrected and checked'},'designer','PATCH')).status,200);}

test('manager notes-only return reaches designer, corrected draft returns to manager and approval releases it to client',async()=>{
 const order=await createOrder();tokens.client=generateClientToken(order);
 const empty=await req(review(order),{action:'return_to_designer',expectedVersion:1,feedback:'  '});assert.equal(empty.status,400);
 assert.equal((await req(review(order),{action:'release_to_client'})).status,400);
 assert.equal((await req(review(order),{action:'release_to_client',expectedVersion:1},'designer')).status,403);
 assert.equal((await req(`/api/proofs/client/1`,undefined,'client')).status,404);
 const returned=await req(review(order),{action:'return_to_designer',expectedVersion:1,feedback:'Change the colour palette throughout.'});assert.equal(returned.status,200,JSON.stringify(returned.data));const round=returned.data.order.revisionRequests.at(-1);assert.equal(round.items.length,1);assert.equal(round.items[0].text,'Change the colour palette throughout.');assert.equal(round.draftVersionNumber,1);assert.equal(round.requestedBy.type,'manager');
 assert.equal((await upload(order,1,{revisionRequestId:round._id,verifyAll:'true'})).status,400);await address(order,round);assert.equal((await upload(order,1,{revisionRequestId:round._id,verifyAll:'true'})).status,200);
 const older=await req(proof(order,1));assert.equal(older.data.canComment,false);const current=await req(proof(order,2));assert.equal(current.data.canComment,true);
 assert.equal((await req(review(order),{action:'release_to_client',expectedVersion:1})).status,409);
 const approved=await req(review(order),{action:'release_to_client',expectedVersion:2});assert.equal(approved.status,200);assert.equal(approved.data.order.status,'client_review');assert.equal(approved.data.order.draftVersions.at(-1).managerReview.status,'approved');
 assert.equal((await req('/api/proofs/client/2',undefined,'client')).status,200);assert.ok(await AuditLog.exists({orderId:order._id,action:'DRAFT_RELEASED_TO_CLIENT','details.versionNumber':2}));
});

test('page annotations and general notes are returned together with immutable version-specific targets and history',async()=>{
 const order=await createOrder();const correction={page:1,kind:'area',rects:[{x:.15,y:.2,width:.3,height:.25}],text:'Replace this photograph.'};
 const saved=await req(proof(order)+'/annotations',correction);assert.equal(saved.status,200);const annotation=saved.data.annotations[0];assert.equal((await req(proof(order),undefined,'designer')).data.annotations.length,0);
 assert.equal((await req(review(order),{action:'release_to_client',expectedVersion:1})).status,409);
 const returned=await req(review(order),{action:'return_to_designer',expectedVersion:1,feedback:'Use consistent spacing throughout.'});assert.equal(returned.status,200);const round=returned.data.order.revisionRequests.at(-1);assert.equal(round.items.length,2);assert.equal(round.items[0].annotationId,annotation._id);assert.equal(round.items[0].pageReference,'1');assert.equal(round.items[1].text,'Use consistent spacing throughout.');assert.equal(round.items[1].pageReference,'');
 const visible=await req(proof(order),undefined,'designer');assert.equal(visible.data.annotations[0]._id,annotation._id);assert.deepEqual(visible.data.annotations[0].rects,correction.rects);assert.ok(visible.data.annotations[0].submittedAt);assert.equal((await req(proof(order)+`/annotations/${annotation._id}`,undefined,'manager','DELETE')).status,403);
 const record=await Order.findById(order._id);assert.equal(record.proofAnnotations[0].source,'manager');assert.equal(record.proofAnnotations[0].version,1);assert.ok(record.proofAnnotations[0].createdAt);assert.equal(record.draftVersions[0].managerReview.feedback,'Use consistent spacing throughout.');
 await address(order,round);assert.equal((await upload(order,1,{revisionRequestId:round._id,verifyAll:'true'})).status,200);assert.equal((await req(review(order),{action:'release_to_client',expectedVersion:2})).status,200);
 assert.ok(await AuditLog.exists({orderId:order._id,action:'DRAFT_RETURNED_TO_DESIGNER','details.versionNumber':1}));
});

test('discarding saved annotations permits approval and duplicate decisions cannot mutate the released draft',async()=>{
 const order=await createOrder();const saved=await req(proof(order)+'/annotations',{page:1,kind:'area',rects:[{x:.1,y:.1,width:.2,height:.2}],text:'Possible correction'});assert.equal(saved.status,200);assert.equal((await req(proof(order)+`/annotations/${saved.data.annotations[0]._id}`,undefined,'manager','DELETE')).status,200);
 assert.equal((await req(review(order),{action:'release_to_client',expectedVersion:1})).status,200);assert.notEqual((await req(review(order),{action:'return_to_designer',expectedVersion:1,feedback:'Duplicate decision'})).status,200);assert.equal((await Order.findById(order._id)).status,'client_review');
});
