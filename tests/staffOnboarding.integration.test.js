import {AccessSession} from '../src/models/AccessSession.model.js';
import {digest,otpSink} from '../src/services/accessSessionService.js';
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app.js';
import { StaffUser } from '../src/models/StaffUser.model.js';
import { Notification } from '../src/models/Notification.model.js';
import { AuditLog } from '../src/models/AuditLog.model.js';
import { Order } from '../src/models/Order.model.js';
import { MagazineForm } from '../src/models/MagazineForm.model.js';
import { generateToken } from '../src/middlewares/auth.middleware.js';
import { resetNotificationSettings, updateNotificationSettings, sendNotification } from '../src/services/notificationService.js';
import { getTransporter } from '../src/services/emailService.js';
import { initialCredentialFields, decryptInitialPassword, runStaffCredentials, generateInitialPassword, passwordErrors, retryStaffCredentials } from '../src/services/staffCredentialService.js';
import { autoAssignOrder, manualAssignOrder } from '../src/services/assignmentService.js';
let mongo,server,base,admin,adminToken,managerToken,form;
const encryptionKey=randomBytes(32).toString('base64');
before(async()=>{
  process.env.NODE_ENV='test';process.env.SECURITY_OTP_SINK='true';
  for(const key of ['SMTP_USER','SMTP_PASS','TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_PHONE_NUMBER','NEXTSMS_API_KEY','NEXTSMS_USERNAME','NEXTSMS_PASSWORD'])delete process.env[key];
  process.env.STAFF_CREDENTIAL_ENCRYPTION_KEY=encryptionKey;
  mongo=await MongoMemoryServer.create();await mongoose.connect(mongo.getUri());
  await Promise.all([StaffUser.init(),Notification.init(),Order.init()]);
  admin=await StaffUser.create({name:'Existing admin',email:'existing-admin@example.test',passwordHash:await bcrypt.hash('Existing!123',10),role:'admin',phone:'0712000001',preferredLanguage:'en'});adminToken=await generateToken(admin,{verifiedAt:new Date()});
  const manager=await StaffUser.create({name:'Manager',email:'existing-manager@example.test',passwordHash:'unused',role:'manager'});managerToken=await generateToken(manager,{verifiedAt:new Date()});
  form=await MagazineForm.create({title:'Onboarding order',slug:'onboarding-test',price:1});
  server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}/api`;
});
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await mongoose.disconnect();await mongo.stop();delete process.env.STAFF_CREDENTIAL_ENCRYPTION_KEY;});
beforeEach(async()=>{process.env.STAFF_CREDENTIAL_ENCRYPTION_KEY=encryptionKey;await resetNotificationSettings();});
async function request(path,body,token=adminToken,method=body===undefined?'GET':'POST') {
 const response=await fetch(base+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 const text=await response.text();let data;try{data=JSON.parse(text);}catch{data={text};}if(data.otpRequired){const code=otpSink.get(digest(data.challengeId)).code;return request('/staff/otp/verify',{challengeId:data.challengeId,code},null);}
 const cookie=response.headers.get('set-cookie');if(cookie && data.token)data.token=cookie.split(';')[0].split('=')[1];return {status:response.status,data};
}
let serial=0;
const details=(extra={})=>({name:'New Designer',email:`new-${serial++}@example.test`,role:'designer',phone:'0712000009',preferredLanguage:'en',...extra});
async function create(extra={}) {const data=details(extra),response=await request('/admin/staff',data);assert.equal(response.status,201,JSON.stringify(response.data));const user=await StaffUser.findById(response.data.user._id).select('+credentialJob');return {user,password:decryptInitialPassword(user),response};}
async function pending(extra={}) {const id=new mongoose.Types.ObjectId(),fields=await initialCredentialFields(id);return StaffUser.create({_id:id,...details(extra),...fields});}
const makeOrder=()=>Order.create({submissionId:`SUB-${new mongoose.Types.ObjectId()}`,formId:form._id,clientName:'Test client',clientWhatsApp:'0712000011',status:'payment_verified'});

test('generated initial passwords are exactly eight unambiguous characters and satisfy every character class',()=>{
 const values=new Set();for(let i=0;i<200;i++){const password=generateInitialPassword();assert.equal(password.length,8);assert.ok(passwordErrors(password).length>0, 'Temporary credentials must be replaced with a full-length passphrase');assert.doesNotMatch(password,/[0O1lI]/);values.add(password);}assert.equal(values.size,200);
});

test('admin creation, notification, restricted first login and password change complete the onboarding journey',async()=>{
 const {user,password,response}=await create();
 assert.equal(user.mustChangePassword,true);assert.equal(user.credentialGeneration,1);assert.ok(Math.abs(+user.temporaryPasswordExpiresAt-+user.passwordChangedAt-86400000)<1000);
 assert.notEqual(user.passwordHash,password);assert.equal(await user.comparePassword(password),true);
 for(const forbidden of [password,user.credentialJob.payload.ciphertext,'passwordHash','credentialJob'])assert.ok(!JSON.stringify(response.data).includes(forbidden));
 assert.equal(response.data.user.onboardingStatus,'awaiting_first_sign_in');assert.equal(response.data.user.credentialDelivery.sms.status,'simulated');assert.equal(response.data.user.credentialDelivery.email.status,'simulated');
 const notifications=await Notification.find({'metadata.staffId':String(user._id)}).lean();assert.equal(notifications.length,2);assert.ok(notifications.every(row=>row.message==='Initial account credentials [REDACTED].'));assert.ok(!JSON.stringify(await AuditLog.find().lean()).includes(password));
 const login=await request('/staff/login',{email:user.email,password},null);assert.equal(login.status,200);assert.equal(login.data.user.mustChangePassword,true);
 const claims=await AccessSession.findById(digest(login.data.token));assert.equal(claims.purpose,'password_setup');assert.ok(claims.expiresAt-Date.now()<=900000);
 for(const path of ['/designer/orders','/manager/orders','/notifications/history','/admin/staff']){const blocked=await request(path,undefined,login.data.token);assert.equal(blocked.status,403);assert.equal(blocked.data.errorCode,'PASSWORD_CHANGE_REQUIRED');}
 assert.equal((await request('/staff/me',undefined,login.data.token)).status,200);
 assert.equal((await request('/staff/preferences',{preferredLanguage:'sw'},login.data.token,'PATCH')).status,200);
 const order=await makeOrder();
 const available=(await request('/manager/designers')).data.designers;assert.ok(available.every(person=>String(person._id)!==String(user._id)));
 await assert.rejects(()=>manualAssignOrder(order,user._id,'Pending onboarding',admin));
 const assignment=await autoAssignOrder(order,admin);assert.equal(assignment.queued,true);
 assert.equal((await request('/staff/change-password',{currentPassword:password,newPassword:'weak'},login.data.token)).status,400);
 assert.equal((await request('/staff/change-password',{currentPassword:'Wrong!123',newPassword:'Chosen long passphrase!7'},login.data.token)).status,400);
 assert.equal((await request('/staff/change-password',{currentPassword:password,newPassword:password},login.data.token)).status,400);
 const changed=await request('/staff/change-password',{currentPassword:password,newPassword:'Chosen long passphrase!7'},login.data.token);assert.equal(changed.status,200,JSON.stringify(changed.data));assert.equal(changed.data.user.mustChangePassword,false);
 const saved=await StaffUser.findById(user._id).select('+credentialJob');assert.equal(saved.credentialJob,null);assert.equal(saved.temporaryPasswordExpiresAt,null);assert.equal(await saved.comparePassword('Chosen long passphrase!7'),true);
 assert.equal((await request('/designer/orders',undefined,changed.data.token)).status,200);assert.equal((await request('/staff/me',undefined,login.data.token)).status,401);
 assert.equal((await request('/staff/login',{email:user.email,password},null)).status,401);
 assert.equal((await request('/staff/login',{email:user.email,password:'Chosen long passphrase!7'},null)).status,200);
 const result=await manualAssignOrder(order,user._id,'Setup completed',admin);assert.equal(result.success,true);
});

test('creation validates contacts and encryption configuration; direct password editing cannot bypass generated credentials',async()=>{
 const before=await StaffUser.countDocuments();const body=details();delete process.env.STAFF_CREDENTIAL_ENCRYPTION_KEY;
 const missing=await request('/admin/staff',body);assert.equal(missing.status,503);assert.equal(missing.data.errorCode,'STAFF_CREDENTIAL_CONFIG_REQUIRED');assert.equal(await StaffUser.countDocuments(),before);
 process.env.STAFF_CREDENTIAL_ENCRYPTION_KEY=encryptionKey;
 assert.equal((await request('/admin/staff',{...body,phone:''})).status,400);assert.equal((await request('/admin/staff',{...body,password:'Manual!123'})).status,400);
 assert.equal((await request('/admin/staff',body,managerToken)).status,403);
 assert.equal((await request(`/admin/staff/${admin._id}`,{password:'Manual!123'},adminToken,'PUT')).status,400);
 const {user}=await create();assert.ok([400,409].includes((await request('/admin/staff',{...body,email:user.email})).status));
});

test('initial password expiry blocks login and setup, erases encrypted delivery material and allows admin reissue',async()=>{
 const {user,password}=await create();const login=await request('/staff/login',{email:user.email,password},null);
 await StaffUser.updateOne({_id:user._id},{$set:{temporaryPasswordExpiresAt:new Date(Date.now()-1000)}});
 assert.equal((await request('/staff/login',{email:user.email,password},null)).data.errorCode,'INITIAL_PASSWORD_EXPIRED');
 assert.equal((await request('/staff/change-password',{currentPassword:password,newPassword:'After expiry passphrase!7'},login.data.token)).status,401);
 await runStaffCredentials({staffId:user._id});assert.equal((await StaffUser.findById(user._id).select('+credentialJob')).credentialJob,null);
 assert.equal((await request(`/admin/staff/${user._id}`)).data.user.onboardingStatus,'expired');
 const reissued=await request(`/admin/staff/${user._id}/initial-password`,{});assert.equal(reissued.status,200);assert.equal(reissued.data.user.credentialGeneration,2);
 const fresh=await StaffUser.findById(user._id).select('+credentialJob'),next=decryptInitialPassword(fresh);assert.notEqual(next,password);assert.equal((await request('/staff/login',{email:user.email,password},null)).status,401);assert.equal((await request('/staff/login',{email:user.email,password:next},null)).status,200);
 assert.equal((await request(`/admin/staff/${user._id}/initial-password`,{},managerToken)).status,403);
});

test('credential delivery uses the chosen language, is persisted before sending and concurrent workers do not duplicate channels',async()=>{
 const user=await pending({preferredLanguage:'sw'}),password=decryptInitialPassword(user);let calls=[];
 const send=async input=>{const stored=await Notification.findOne({recipientUser:user._id,channel:input.channel});assert.equal(stored.status,'queued');assert.equal(stored.attempts,1);assert.ok(!JSON.stringify(stored.toObject()).includes(password));calls.push(input);return {status:'sent'};};
 await Promise.all([runStaffCredentials({staffId:user._id,send}),runStaffCredentials({staffId:user._id,send}),runStaffCredentials({staffId:user._id,send})]);
 assert.equal(calls.length,2);assert.ok(calls.every(input=>input.message.includes('Nenosiri la awali')&&input.message.includes(password)&&input.message.includes('Wadhifa: Mbunifu')&&input.message.includes('https://tinzel.stryxis.com/staff')));assert.ok(calls.find(input=>input.channel==='email').html.includes('lang="sw"'));
 assert.equal((await StaffUser.findById(user._id)).credentialDelivery.sms.status,'sent');
});

test('only failed credential channels retry, with five automatic attempts and retained redacted history',async()=>{
 const user=await pending(),start=new Date();let sms=0,email=0,now=start;
 const send=async input=>{if(input.channel==='sms'){sms++;return {status:'failed',retryable:true};}email++;return {status:'sent'};};
 for(const delay of [0,60000,300000,900000,3600000]){now=new Date(now.getTime()+delay);await runStaffCredentials({staffId:user._id,now,send});}
 assert.equal(sms,5);assert.equal(email,1);const row=await Notification.findOne({recipientUser:user._id,channel:'sms'});assert.equal(row.attempts,5);assert.equal(row.retryable,false);assert.equal(row.attemptHistory.length,5);
});

test('interrupted sends become unconfirmed and cannot be automatically repeated',async()=>{
 const user=await pending();await runStaffCredentials({staffId:user._id,send:async()=>({status:'sent'})});
 const row=await Notification.findOne({recipientUser:user._id,channel:'sms'});
 await Notification.updateOne({_id:row._id},{$set:{status:'queued'}});await StaffUser.updateOne({_id:user._id},{$set:{'credentialJob.state':'running','credentialJob.leaseUntil':new Date(0)}});
 let calls=0;await runStaffCredentials({staffId:user._id,send:async()=>{calls++;return {status:'sent'};}});assert.equal(calls,0);assert.equal((await Notification.findById(row._id)).status,'unconfirmed');
 await assert.rejects(()=>retryStaffCredentials(user._id,'sms'),/unknown/);
 await retryStaffCredentials(user._id,'sms',{confirmUncertain:true});assert.equal((await Notification.findById(row._id)).status,'simulated');
});

test('disabled channels, deactivation and replaced credentials stop pending deliveries',async()=>{
 const user=await pending();await updateNotificationSettings({channels:{sms:false,email:true}});await runStaffCredentials({staffId:user._id});
 assert.equal((await StaffUser.findById(user._id)).credentialDelivery.sms.status,'skipped');await resetNotificationSettings();
 const oldRow=await Notification.findOne({recipientUser:user._id,channel:'sms'});
 const reset=await request(`/admin/staff/${user._id}/initial-password`,{});assert.equal(reset.status,200);
 const outdated=await request(`/notifications/resend/${oldRow._id}`,{channel:'sms'});assert.equal(outdated.status,409);
 const deactivated=await pending();await request(`/admin/staff/${deactivated._id}`,{isActive:false},adminToken,'PUT');let calls=0;await runStaffCredentials({staffId:deactivated._id,send:async()=>{calls++;return {status:'sent'};}});assert.equal(calls,0);assert.equal((await StaffUser.findById(deactivated._id).select('+credentialJob')).credentialJob,null);
});

test('concurrent reissues and password changes cannot overwrite newer credential generations',async()=>{
 const {user,password}=await create(),login=await request('/staff/login',{email:user.email,password},null);
 const resets=await Promise.all([request(`/admin/staff/${user._id}/initial-password`,{}),request(`/admin/staff/${user._id}/initial-password`,{})]);assert.ok(resets.some(result=>result.status===200));assert.ok(resets.every(result=>result.status===200||result.status===409));
 assert.equal((await request('/staff/change-password',{currentPassword:password,newPassword:'Concurrent passphrase!8'},login.data.token)).status,401);
 const saved=await StaffUser.findById(user._id).select('+credentialJob'),newPassword=decryptInitialPassword(saved),nextLogin=await request('/staff/login',{email:saved.email,password:newPassword},null);
 const changes=await Promise.all([request('/staff/change-password',{currentPassword:newPassword,newPassword:'Winner one passphrase!8'},nextLogin.data.token),request('/staff/change-password',{currentPassword:newPassword,newPassword:'Winner two passphrase!8'},nextLogin.data.token)]);
 assert.equal(changes.filter(result=>result.status===200).length,1);assert.equal((await StaffUser.findById(user._id)).mustChangePassword,false);
});

test('existing accounts keep their passwords and full access without a forced setup',async()=>{
 const login=await request('/staff/login',{email:admin.email,password:'Existing!123'},null);assert.equal(login.status,200);assert.equal(login.data.user.mustChangePassword,false);assert.equal((await AccessSession.findById(digest(login.data.token))).purpose,'staff');assert.equal((await request('/admin/staff',undefined,login.data.token)).status,200);
});

test('encryption failures are visible without exposing secrets and recover after configuration is restored',async()=>{
 const user=await pending(),password=decryptInitialPassword(user);delete process.env.STAFF_CREDENTIAL_ENCRYPTION_KEY;
 await runStaffCredentials({staffId:user._id});const failed=await StaffUser.findById(user._id);assert.match(failed.credentialDelivery.error,/encryption/);assert.ok(!JSON.stringify(failed).includes(password));
 process.env.STAFF_CREDENTIAL_ENCRYPTION_KEY=encryptionKey;await runStaffCredentials({staffId:user._id,now:new Date(Date.now()+61000)});const recovered=await StaffUser.findById(user._id);assert.equal(recovered.credentialDelivery.sms.status,'simulated');assert.equal(recovered.credentialDelivery.error,undefined);
});

test('setup tokens are bounded by initial expiry and reissue invalidates existing normal sessions',async()=>{
 const id=new mongoose.Types.ObjectId(),fields=await initialCredentialFields(id);fields.temporaryPasswordExpiresAt=new Date(Date.now()+120000);const user=await StaffUser.create({_id:id,...details(),...fields});
 const claims=await AccessSession.findById(digest(await generateToken(user)));assert.ok(claims.expiresAt-Date.now()<=120000);
 const normal=await StaffUser.create({...details(),passwordHash:await bcrypt.hash('NormalPass!7',10)}),oldToken=await generateToken(normal,{verifiedAt:new Date()});
 assert.equal((await request('/designer/orders',undefined,oldToken)).status,200);
 assert.equal((await request(`/admin/staff/${normal._id}/initial-password`,{})).status,200);
 assert.equal((await request('/staff/me',undefined,oldToken)).status,401);
});

test('provider delivery callbacks update the matching account generation and cannot overwrite a reissue',async()=>{
 const {updateNotificationDeliveryStatus}=await import('../src/services/notificationService.js');
 const user=await pending();await runStaffCredentials({staffId:user._id,send:async input=>({status:'sent',sid:`test-${user._id}-${input.channel}`})});
 await updateNotificationDeliveryStatus({twilioSid:`test-${user._id}-sms`,status:'delivered'});assert.equal((await StaffUser.findById(user._id)).credentialDelivery.sms.status,'delivered');
 const reset=await request(`/admin/staff/${user._id}/initial-password`,{});assert.equal(reset.status,200);
 await updateNotificationDeliveryStatus({twilioSid:`test-${user._id}-sms`,status:'undelivered'});assert.equal((await StaffUser.findById(user._id)).credentialDelivery.sms.status,'simulated');
});

test('an initial password that expires during password hashing cannot complete setup',async()=>{
 const {user,password}=await create(),login=await request('/staff/login',{email:user.email,password},null),originalHash=bcrypt.hash;
 await StaffUser.updateOne({_id:user._id},{$set:{temporaryPasswordExpiresAt:new Date(Date.now()+300)}});
 const spy=mock.method(bcrypt,'hash',async(...args)=>{if(args[0]==='Expiry race passphrase!7')await new Promise(resolve=>setTimeout(resolve,400));return originalHash(...args);});
 try{const response=await request('/staff/change-password',{currentPassword:password,newPassword:'Expiry race passphrase!7'},login.data.token);assert.equal(response.status,401);assert.equal(response.data.errorCode,'INITIAL_PASSWORD_EXPIRED');assert.equal((await StaffUser.findById(user._id)).mustChangePassword,true);}finally{spy.mock.restore();}
});

// A provider may echo rejected content; credential bodies must still stay out of diagnostics.
test('credential provider errors cannot echo initial passwords into logs or delivery results',async()=>{
 const previousUser=process.env.SMTP_USER,previousPass=process.env.SMTP_PASS;
 process.env.SMTP_USER='simulation@example.test';process.env.SMTP_PASS='not-a-live-password';
 const secret=generateInitialPassword(),logs=[];
 const send=mock.method(getTransporter(),'sendMail',async()=>{throw Object.assign(new Error(`Rejected body: ${secret}`),{responseCode:450});});
 const logger=mock.method(console,'error',(...args)=>logs.push(args.join(' ')));
 try {
  const result=await sendNotification({to:'recipient@example.test',channel:'email',template:'staff_credentials',message:secret,skipPersistence:true});
  assert.equal(result.status,'failed');assert.equal(result.retryable,true);
  assert.ok(!JSON.stringify(logs).includes(secret));assert.ok(!result.error.includes(secret));
 }finally{send.mock.restore();logger.mock.restore();if(previousUser===undefined)delete process.env.SMTP_USER;else process.env.SMTP_USER=previousUser;if(previousPass===undefined)delete process.env.SMTP_PASS;else process.env.SMTP_PASS=previousPass;}
});
