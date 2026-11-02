import {randomBytes,createHash,createHmac,randomInt} from 'node:crypto';
import {AccessSession,AccessChallenge} from '../models/AccessSession.model.js';
import {getJwtSecret} from '../middlewares/auth.middleware.js';
import {consumeRateLimit} from '../middlewares/rateLimiter.js';
import {sendNextSMS} from './smsService.js';
import {sendEmail} from './emailService.js';
export const digest=value=>createHash('sha256').update(String(value)).digest('hex');
export const contactFingerprint=user=>digest(`${user.email}|${user.phone}`);
export const otpSink=new Map();
export function assertDeliveryConfiguration(){if(process.env.NODE_ENV==='production' && process.env.SECURITY_OTP_SINK)throw new Error('Test OTP delivery is forbidden in production');}
assertDeliveryConfiguration();
export const cookieName=kind=>`${process.env.NODE_ENV==='production'?'__Host-':''}tinzel_${kind}`;
export function cookieValue(req,kind){const part=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName(kind)+'='));return part?.slice(part.indexOf('=')+1);}
export function setSessionCookie(res,kind,value,maxAge){res.cookie(cookieName(kind),value,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',path:'/',maxAge});}
export async function createSession(kind,subject,{verifiedAt,scope,purpose}={}){
 const token=randomBytes(32).toString('hex'), now=Date.now();
 const duration=kind==='printer'?600000:kind==='client'?8*3600000:12*3600000;
 const expiresAt=new Date(Math.min(now+(subject.mustChangePassword?900000:duration),subject.mustChangePassword?+new Date(subject.temporaryPasswordExpiresAt):Infinity));
 if(+expiresAt<=now)throw Object.assign(new Error('Initial password expired'),{status:401});
 await AccessSession.create({_id:digest(token),kind,subjectId:String(subject._id),role:subject.role,tokenVersion:subject.tokenVersion||0,
  contactFingerprint:kind==='staff'?contactFingerprint(subject):kind==='client'?digest(`${subject.trackingId}|${subject.clientWhatsApp}`):undefined,verifiedAt,scope,purpose:purpose||(subject.mustChangePassword?'password_setup':kind),
  expiresAt,idleUntil:new Date(Math.min(+expiresAt,now+1800000)),csrf:randomBytes(24).toString('hex'),previewId:randomBytes(16).toString('hex')});
 return token;
}
export async function readSession(req,kind){
 const cookie=cookieValue(req,kind);const token=cookie || String(req.headers.authorization||'').replace(/^Bearer /,'');
 if(!/^[a-f0-9]{64}$/.test(token))throw Object.assign(new Error('Please sign in again'),{status:401});
 const session=await AccessSession.findOneAndUpdate({_id:digest(token),kind,expiresAt:{$gt:new Date()},idleUntil:{$gt:new Date()}},{$set:{idleUntil:new Date(Date.now()+1800000)}},{returnDocument:'after'});
 if(!session)throw Object.assign(new Error('Session expired or revoked'),{status:401});
 if(cookie && !['GET','HEAD','OPTIONS'].includes(req.method)){
  const origin=req.headers.origin;
  const allowed=[process.env.FRONTEND_URL,...(process.env.ALLOWED_ORIGINS||'').split(',')].filter(Boolean);
  if(process.env.NODE_ENV!=='production')allowed.push('http://127.0.0.1:5177','http://localhost:5173');
  if(!origin || !allowed.includes(origin) || req.headers['x-csrf-token']!==session.csrf)throw Object.assign(new Error('Request verification failed'),{status:403});
 }
 req.accessSession=session;return session;
}
export async function requireRecentVerification(req,res,next){if(!req.accessSession?.verifiedAt || Date.now()-new Date(req.accessSession.verifiedAt)>600000)return res.status(403).json({errorCode:'OTP_REQUIRED',message:'Verify your identity before continuing'});next();}
async function limit(scope,key,maxAttempts,windowMs){const r=await consumeRateLimit({scope,key,maxAttempts,windowMs,failClosed:true});if(!r.allowed)throw Object.assign(new Error('Please wait before requesting another code'),{status:429});}
export async function issueChallenge({subjectId,purpose,channel,destination,ip,scope}){
 assertDeliveryConfiguration();if(!['email','sms'].includes(channel)||!destination)throw Object.assign(new Error('Choose a configured email or SMS destination'),{status:400});
 await limit('otp-send-minute',`${purpose}:${subjectId}`,1,60000);
 await limit('otp-send-account',subjectId,5,900000);await limit('otp-send-ip',ip,20,900000);
 const previous=await AccessChallenge.find({subjectId,purpose,consumedAt:null}).select('_id').lean();for(const item of previous)otpSink.delete(item._id);
 await AccessChallenge.updateMany({subjectId,purpose,consumedAt:null},{$set:{consumedAt:new Date()}});
 const id=randomBytes(32).toString('hex'), code=String(randomInt(100000,1000000));
 const codeHash=createHmac('sha256',getJwtSecret()).update(`${id}:${code}`).digest('hex');
 await AccessChallenge.create({_id:digest(id),subjectId,purpose,channel,destination,codeHash,expiresAt:new Date(Date.now()+300000),scope});
 try{
  if(process.env.SECURITY_OTP_SINK==='true' && process.env.NODE_ENV==='test')otpSink.set(digest(id),{code,channel,destination});
  else if(channel==='sms')await sendNextSMS(destination,`Tinzel verification code: ${code}. Expires in 5 minutes. Do not share this code.`);
  else {const result=await sendEmail({to:destination,subject:'Tinzel verification code',text:`Your code is ${code}. It expires in 5 minutes.`,sensitive:true});if(result.mode!=='smtp_live')throw new Error('Delivery unavailable');}
  await AccessChallenge.updateOne({_id:digest(id)},{$set:{ready:true}});
 }catch{await AccessChallenge.deleteOne({_id:digest(id)});throw Object.assign(new Error('Verification delivery unavailable. Please try again later.'),{status:503});}
 return {challengeId:id,expiresIn:300,channel};
}
export async function consumeChallenge(id,code,purpose,ip){
 await limit('otp-verify-ip',ip,50,900000);
 const row=await AccessChallenge.findOneAndUpdate({_id:digest(id),purpose,ready:true,consumedAt:null,expiresAt:{$gt:new Date()},attempts:{$lt:5}},{$inc:{attempts:1}},{returnDocument:'after'});
 if(!row)throw Object.assign(new Error('Code expired or verification limit reached'),{status:401});
 await limit('otp-verify-account',row.subjectId,20,900000);
 const expected=createHmac('sha256',getJwtSecret()).update(`${id}:${String(code)}`).digest('hex');
 if(expected!==row.codeHash)throw Object.assign(new Error('Invalid verification code'),{status:401});
 const used=await AccessChallenge.findOneAndUpdate({_id:row._id,consumedAt:null},{$set:{consumedAt:new Date()}},{returnDocument:'after'});
 if(!used)throw Object.assign(new Error('Code has already been used'),{status:401});
 otpSink.delete(row._id);return used;
}
