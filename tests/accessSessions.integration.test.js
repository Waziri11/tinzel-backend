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
 const login=await call('/api/staff/login',{email:user.email,password:'TestPassword!123',channel:'email'});
 assert.equal(login.data.channel,'sms');assert.equal(otpSink.get(digest(login.data.challengeId)).destination,user.phone);
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
test('OTP permits five attempts, rejects reuse, expires, and invalidates older codes on resend',async()=>{
 const {issueChallenge,consumeChallenge}=await import('../src/services/accessSessionService.js');
 const {RateLimitBucket}=await import('../src/middlewares/rateLimiter.js');
 const args={subjectId:'attempt-fixture',purpose:'test',channel:'email',destination:'fixture@example.test',ip:'test-fixture-ip'};
 const first=await issueChallenge(args),firstCode=otpSink.get(digest(first.challengeId)).code;
 for(let i=0;i<5;i++)await assert.rejects(consumeChallenge(first.challengeId,'000000','test',args.ip));
 await assert.rejects(consumeChallenge(first.challengeId,firstCode,'test',args.ip),/limit/);
 await RateLimitBucket.deleteMany({_id:{$regex:'otp-send-minute:test:attempt-fixture'}});
 const second=await issueChallenge(args);await AccessChallenge.updateOne({_id:digest(second.challengeId)},{$set:{expiresAt:new Date(0)}});
 await assert.rejects(consumeChallenge(second.challengeId,'123456','test',args.ip),/expired/);
 await RateLimitBucket.deleteMany({_id:{$regex:'otp-send-minute:test:attempt-fixture'}});
 const third=await issueChallenge({...args,channel:'sms'});const thirdCode=otpSink.get(digest(third.challengeId)).code;
 const race=await Promise.allSettled([consumeChallenge(third.challengeId,thirdCode,'test',args.ip),consumeChallenge(third.challengeId,thirdCode,'test',args.ip)]);
 assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
});

test('resend shares channel limits and replaces the previous challenge',async()=>{
 const {issueChallenge,consumeChallenge}=await import('../src/services/accessSessionService.js');
 const {RateLimitBucket}=await import('../src/middlewares/rateLimiter.js');
 const args={subjectId:'resend-fixture',purpose:'test',channel:'email',destination:'fixture@example.test',ip:'resend-ip'};
 const first=await issueChallenge(args),code=otpSink.get(digest(first.challengeId)).code;
 await assert.rejects(issueChallenge({...args,channel:'sms'}),e=>e.status===429);
 await RateLimitBucket.deleteOne({_id:'otp-send-minute:test:resend-fixture'});
 const second=await issueChallenge({...args,channel:'sms'});
 await assert.rejects(consumeChallenge(first.challengeId,code,'test',args.ip));
 assert.equal(otpSink.has(digest(first.challengeId)),false);
 assert.equal((await consumeChallenge(second.challengeId,otpSink.get(digest(second.challengeId)).code,'test',args.ip)).channel,'sms');
});
test('production rejects test delivery and delivery failures cannot issue usable challenges',async()=>{
 const {issueChallenge,assertDeliveryConfiguration}=await import('../src/services/accessSessionService.js');
 const originalEnv=process.env.NODE_ENV;process.env.NODE_ENV='production';
 try{assert.throws(assertDeliveryConfiguration,/forbidden/);}finally{process.env.NODE_ENV=originalEnv;}
 const {AccessChallenge}=await import('../src/models/AccessSession.model.js');
 const original=AccessChallenge.updateOne;AccessChallenge.updateOne=async()=>{throw new Error('Delivery persistence failure');};
 try{await assert.rejects(issueChallenge({subjectId:'failure-fixture',purpose:'test',channel:'email',destination:'fixture@example.test',ip:'failure-ip'}),e=>e.status===503);
 assert.equal(await AccessChallenge.countDocuments({subjectId:'failure-fixture'}),0);
 }finally{AccessChallenge.updateOne=original;}
});
test('contact replacement requires recent identity verification and new destination OTP; revokes sessions',async()=>{
 await StaffUser.updateOne({_id:user._id},{$set:{role:'manager'}});user=await StaffUser.findById(user._id);
 const token=await createSession('staff',user,{verifiedAt:new Date()});
 const session=await AccessSession.findById(digest(token));const options={cookie:`tinzel_staff=${token}`,csrf:session.csrf};
 assert.equal((await call('/api/staff/contact',{channel:'email',destination:'verified-new@example.test'},options)).status,400);
 const started=await call('/api/staff/contact',{channel:'sms',destination:'0712000088'},options);assert.equal(started.status,200);
 assert.equal((await StaffUser.findById(user._id)).email,user.email);
 const code=otpSink.get(digest(started.data.challengeId)).code;
 assert.equal((await call('/api/staff/contact/verify',{challengeId:started.data.challengeId,code},options)).status,200);
 assert.equal((await StaffUser.findById(user._id)).phone,'0712000088');
 assert.equal((await call('/api/staff/me',null,options)).status,401);
});

test('SMTP provider failure fails closed without a live verification challenge',async()=>{
 const {default:nodemailer}=await import('nodemailer');const {issueChallenge}=await import('../src/services/accessSessionService.js');
 const keys=['SECURITY_OTP_SINK','SMTP_USER','SMTP_PASS','SMTP_HOST'];const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));const create=nodemailer.createTransport;
 try{
 delete process.env.SECURITY_OTP_SINK;process.env.SMTP_USER='fixture@example.test';process.env.SMTP_PASS='synthetic';process.env.SMTP_HOST='smtp.example.test';
 nodemailer.createTransport=()=>({sendMail:async()=>{throw new Error('Synthetic provider outage');},close(){}});
 await assert.rejects(issueChallenge({subjectId:'provider-failure',purpose:'test',channel:'email',destination:'fixture@example.test',ip:'provider-failure-ip'}),e=>e.status===503);
 assert.equal(await AccessChallenge.countDocuments({subjectId:'provider-failure'}),0);
 }finally{nodemailer.createTransport=create;for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}}
});

test('staff resend and step-up force SMS; legacy email codes cannot authenticate',async()=>{
 const {issueChallenge,contactFingerprint}=await import('../src/services/accessSessionService.js');
 const {RateLimitBucket}=await import('../src/middlewares/rateLimiter.js');
 const person=await StaffUser.create({name:'SMS only',email:'sms-only@example.test',phone:'0712000044',role:'admin',passwordHash:await bcrypt.hash('TestPassword!123',10)});
 const legacy=await issueChallenge({subjectId:String(person._id),purpose:'login',channel:'email',destination:person.email,ip:'legacy-test',scope:{tokenVersion:0,contactFingerprint:contactFingerprint(person)}});
 const legacyCode=otpSink.get(digest(legacy.challengeId)).code;
 assert.equal((await call('/api/staff/otp/verify',{challengeId:legacy.challengeId,code:legacyCode})).status,401);
 await RateLimitBucket.deleteOne({_id:`otp-send-minute:login:${person._id}`});
 const login=await call('/api/staff/login',{email:person.email,password:'TestPassword!123'});assert.equal(login.data.channel,'sms');
 await RateLimitBucket.deleteOne({_id:`otp-send-minute:login:${person._id}`});
 const resend=await call('/api/staff/otp/resend',{challengeId:login.data.challengeId,channel:'email'});assert.equal(resend.data.channel,'sms');assert.equal(otpSink.get(digest(resend.data.challengeId)).destination,person.phone);
 const token=await createSession('staff',person,{verifiedAt:new Date()});const session=await AccessSession.findById(digest(token));
 const step=await call('/api/staff/step-up',{channel:'email'},{cookie:`tinzel_staff=${token}`,csrf:session.csrf});assert.equal(step.data.channel,'sms');assert.equal(otpSink.get(digest(step.data.challengeId)).destination,person.phone);
});

test('SMS verification remembers only this submission and browser, across tracking IDs and ordinary sign-out', async () => {
 const {Order} = await import('../src/models/Order.model.js');
 const {Notification} = await import('../src/models/Notification.model.js');
 const createOrder = submissionId => Order.create({submissionId, formId:new mongoose.Types.ObjectId(),
   formTitle:'Test magazine', clientName:'Reader', clientWhatsApp:'0712000098', clientEmail:'reader@example.test'});
 const first=await createOrder('SUB-TRUST-A'), second=await createOrder('SUB-TRUST-B');
 const requestCode=(order,cookie)=>call('/api/client/request-otp',{trackingId:order.submissionId,clientWhatsApp:order.clientWhatsApp},{cookie});
 const resume=(trackingId,cookie)=>call('/api/client/request-otp',{trackingId,resumeOnly:true},{cookie});
 const issued=await requestCode(first);
 assert.equal(issued.data.channel,'sms');
 const code=issued.data.devOtp;
 const verify=()=>fetch(base+'/api/client/verify-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({trackingId:first.submissionId,otp:code})});
 const attempts=await Promise.all([verify(),verify()]);
 assert.equal(attempts.filter(response=>response.ok).length,1);
 const verified=attempts.find(response=>response.ok);
 const cookies=verified.headers.getSetCookie();
 const device=cookies.find(value=>value.startsWith('tinzel_tracking_')).split(';')[0];
 const active=cookies.find(value=>value.startsWith('tinzel_client=')).split(';')[0];
 assert.match(cookies.find(value=>value.startsWith('tinzel_tracking_')), /HttpOnly/i);
 const csrf=(await verified.json()).csrf;
 assert.equal((await call('/api/client/logout',{}, {cookie:active,csrf})).status,200);
 assert.equal((await call('/api/client/order',null,{cookie:active})).status,401);
 const trackingId='TNZ-TRUST-A';
 await Order.updateOne({_id:first._id},{$set:{trackingId}});
 assert.equal((await resume(trackingId,device)).data.clientToken,'cookie');
 assert.equal((await resume(trackingId)).data.clientToken,undefined);
 assert.equal((await requestCode(first,device)).data.clientToken,'cookie');
 const messages=await Notification.find({orderId:first._id,template:'client_otp'}).lean();
 assert.deepEqual(messages.map(n=>n.channel),['sms']);
 assert.ok(!messages[0].message.includes(code));
 const forged=device.replace(String(first._id),String(second._id));
 assert.equal((await resume(second.submissionId,forged)).data.clientToken,undefined);
 const nextCode=await requestCode(second,device);
 assert.equal(nextCode.data.channel,'sms');
 const secondVerification=await fetch(base+'/api/client/verify-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({trackingId:second.submissionId,otp:nextCode.data.devOtp})});
 assert.equal(secondVerification.status,200);
 const secondCookies=secondVerification.headers.getSetCookie().map(header=>header.split(';')[0]);
 const forget=await call('/api/client/logout',{forgetDevice:true},{cookie:secondCookies.join('; '),csrf:(await secondVerification.json()).csrf});
 assert.equal(forget.status,200);
 assert.equal((await resume(second.submissionId,secondCookies.join('; '))).data.clientToken,undefined);
 await Order.updateOne({_id:first._id},{$set:{clientWhatsApp:'0712000099'}});
 assert.equal((await resume(trackingId,device)).data.clientToken,undefined);
 await Order.updateOne({_id:first._id},{$set:{clientWhatsApp:first.clientWhatsApp}});
 const deviceId=digest(device.split('=')[1]);
 await AccessSession.updateOne({_id:deviceId},{$set:{expiresAt:new Date(0)}});
 assert.equal((await resume(trackingId,device)).data.clientToken,undefined);
 // Administrative revocation invalidates the grant as well as active sessions.
 await AccessSession.updateOne({_id:deviceId},{$set:{expiresAt:new Date(Date.now()+60000)}});
 const managerToken=await createSession('staff',await StaffUser.findById(user._id),{verifiedAt:new Date()});
 const managerSession=await AccessSession.findById(digest(managerToken));
 const revoked=await call('/api/security/orders/'+first._id+'/revoke-client',{}, {cookie:'tinzel_staff='+managerToken,csrf:managerSession.csrf});
 assert.equal(revoked.status,200);
 assert.equal(await AccessSession.exists({_id:deviceId}),null);
 assert.equal((await resume(first.submissionId,device)).data.clientToken,undefined);
});
