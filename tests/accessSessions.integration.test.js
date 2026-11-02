import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import {MongoMemoryServer} from 'mongodb-memory-server';
process.env.NODE_ENV='test';process.env.SECURITY_OTP_SINK='true';
process.env.JWT_SECRET='security-test-only-independent-authentication-key';
const {default:app}=await import('../src/app.js');
const {StaffUser}=await import('../src/models/StaffUser.model.js');
const {AccessSession,AccessChallenge}=await import('../src/models/AccessSession.model.js');
const {otpSink,digest,createSession}=await import('../src/services/accessSessionService.js');
let db,server,base,user;
before(async()=>{db=await MongoMemoryServer.create();await mongoose.connect(db.getUri());user=await StaffUser.create({name:'Security Manager',email:'security@example.test',phone:'0712000001',role:'manager',passwordHash:await bcrypt.hash('TestPassword!123',10)});server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;});
after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await mongoose.disconnect();await db.stop();});
async function call(path,body,{cookie,csrf,origin='http://127.0.0.1:5177',method=body?'POST':'GET'}={}){const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Origin:origin,...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json().catch(()=>({})),cookie:response.headers.get('set-cookie')?.split(';')[0]};}
test('privileged login requires OTP; cookie session enforces CSRF and replay prevention',async()=>{
 const login=await call('/api/staff/login',{email:user.email,password:'TestPassword!123',channel:'sms'});
 assert.equal(login.status,200);assert.equal(login.data.otpRequired,true);assert.equal(login.cookie,undefined);
 const code=otpSink.get(digest(login.data.challengeId)).code;
 assert.equal((await call('/api/staff/otp/verify',{challengeId:login.data.challengeId,code:'000000'})).status,401);
 const verified=await call('/api/staff/otp/verify',{challengeId:login.data.challengeId,code});assert.equal(verified.status,200);assert.ok(verified.cookie);assert.equal(verified.data.token,'cookie');
 assert.equal((await call('/api/staff/otp/verify',{challengeId:login.data.challengeId,code})).status,401);
 assert.equal((await call('/api/staff/me',null,{cookie:verified.cookie})).status,200);
 assert.equal((await call('/api/staff/preferences',{preferredLanguage:'en'},{cookie:verified.cookie,method:'PATCH'})).status,403);
 assert.equal((await call('/api/staff/preferences',{preferredLanguage:'en'},{cookie:verified.cookie,csrf:verified.data.csrf,method:'PATCH',origin:'https://evil.vercel.app'})).status,403);
 assert.equal((await call('/api/staff/preferences',{preferredLanguage:'en'},{cookie:verified.cookie,csrf:verified.data.csrf,method:'PATCH'})).status,200);
 assert.equal((await call('/api/staff/logout',{}, {cookie:verified.cookie,csrf:verified.data.csrf})).status,200);
 assert.equal((await call('/api/staff/me',null,{cookie:verified.cookie})).status,401);
});
test('opaque sessions reject JWTs, expiry, contact changes and role changes',async()=>{
 for(const change of [{idleUntil:new Date(0)},{expiresAt:new Date(0)}]){const token=await createSession('staff',user,{verifiedAt:new Date()});await AccessSession.updateOne({_id:digest(token)},{$set:change});assert.equal((await call('/api/staff/me',null,{cookie:`tinzel_staff=${token}`})).status,401);}
 const token=await createSession('staff',user,{verifiedAt:new Date()});await StaffUser.updateOne({_id:user._id},{$set:{role:'designer'}});assert.equal((await call('/api/staff/me',null,{cookie:`tinzel_staff=${token}`})).status,401);
 assert.equal((await call('/api/staff/me',null,{cookie:'tinzel_staff=old.jwt.token'})).status,401);
});
