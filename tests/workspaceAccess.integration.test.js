import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {MongoMemoryServer} from 'mongodb-memory-server';
import {randomBytes} from 'node:crypto';
import app from '../src/app.js';
import {StaffUser} from '../src/models/StaffUser.model.js';
import {generateToken} from '../src/middlewares/auth.middleware.js';
let mongo,server,base,users={},tokens={};
before(async()=>{
 process.env.STAFF_CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('base64');
 for(const key of ['SMTP_USER','SMTP_PASS','NEXTSMS_API_KEY','NEXTSMS_USERNAME','NEXTSMS_PASSWORD','TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_PHONE_NUMBER'])delete process.env[key];
 mongo=await MongoMemoryServer.create();await mongoose.connect(mongo.getUri());
 for(const role of ['admin','manager','designer']){users[role]=await StaffUser.create({name:role,email:`${role}@workspace.test`,role,passwordHash:'unused',phone:'0712000011'});tokens[role]=generateToken(users[role]);}
 server=app.listen(0);await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}/api`;
});
after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await mongoose.disconnect();await mongo.stop();});
async function req(path,role='manager',method='GET',body){const res=await fetch(base+path,{method,headers:{Authorization:`Bearer ${tokens[role]}`,'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json()};}
test('manager lists designers only and cannot target privileged users or delete',async()=>{
 const r=await req('/manager/staff');assert.equal(r.status,200);assert.ok(r.data.staff.length);assert.ok(r.data.staff.every(x=>x.role==='designer'&&!x.passwordHash));
 for(const role of ['admin','manager'])for(const [method,suffix,body] of [['GET','',undefined],['PUT','',{name:'Changed'}],['POST','/initial-password',{}],['POST','/credential-delivery/retry',{channel:'sms'}]])assert.equal((await req(`/manager/staff/${users[role]._id}${suffix}`,'manager',method,body)).status,404);
 assert.equal((await req(`/manager/staff/${users.designer._id}`,'manager','DELETE')).status,403);
 assert.equal((await req(`/manager/staff/${users.designer._id}`,'manager','PUT',{role:'admin'})).status,403);
 assert.equal((await req('/admin/staff')).status,403);
 assert.equal((await req('/manager/staff','designer')).status,403);
});
test('manager creates designer through onboarding and can edit capacity',async()=>{
 const r=await req('/manager/staff','manager','POST',{name:'New designer',email:'new@workspace.test',role:'designer',phone:'0712000012',maxActiveWorkload:3});assert.equal(r.status,201,JSON.stringify(r.data));assert.equal(r.data.user.mustChangePassword,true);assert.ok(!r.data.user.passwordHash&&!r.data.user.credentialJob);
 assert.equal((await req('/manager/staff','manager','POST',{name:'Wrong',email:'wrong@workspace.test',role:'manager',phone:'0712000012'})).status,403);
 const edit=await req(`/manager/staff/${users.designer._id}`,'manager','PUT',{maxActiveWorkload:9});assert.equal(edit.status,200);assert.equal(edit.data.user.maxActiveWorkload,9);
});
test('profile updates cannot alter email or role',async()=>{
 const r=await req('/staff/profile','manager','PATCH',{name:'Manager Updated',phone:'0712000013'});assert.equal(r.status,200);assert.equal(r.data.user.name,'Manager Updated');
 assert.equal((await req('/staff/profile','manager','PATCH',{name:'x',phone:'0712000013',role:'admin'})).status,400);
 assert.equal((await req('/staff/profile','manager','PATCH',{name:'x',phone:'bad'})).status,400);
 assert.equal((await req('/staff/me')).data.user.phone,'0712000013');
});
test('system summaries are restricted, available independently and never invent quotas',async()=>{
 for(const section of ['runtime','storage','messaging']){assert.equal((await req(`/system/summary/${section}`,'designer')).status,403);const r=await req(`/system/summary/${section}`);assert.equal(r.status,200,JSON.stringify(r.data));assert.ok(r.data.measuredAt);assert.ok(!JSON.stringify(r.data).includes('password'));if(section==='runtime'){assert.ok(r.data.processMemoryBytes>0);assert.equal(r.data.hostingRamAvailableBytes,null);}if(section==='storage')assert.equal(r.data.quotaBytes,null);}
});
