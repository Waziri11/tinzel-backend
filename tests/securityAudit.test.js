import {test} from 'node:test';
import assert from 'node:assert/strict';
import {securityEventData} from '../src/services/securityAuditService.js';
import {SecurityEvent} from '../src/models/SecurityEvent.model.js';
test('security audit only accepts explicit non-secret fields and fixed retention',()=>{
 const event=securityEventData({action:'DOWNLOAD_DENIED',actorId:'actor',password:'secret',otp:'123456',token:'secret',url:'https://example.test/?sig=secret'});
 assert.equal(event.action,'DOWNLOAD_DENIED');
 for(const field of ['password','otp','token','url'])assert.equal(event[field],undefined);
 assert.ok(event.expiresAt>Date.now()+364*86400000);
});
test('security events reject mutation before database access',async()=>{
 await assert.rejects(SecurityEvent.updateOne({},{$set:{action:'changed'}}),/append-only/);
 await assert.rejects(SecurityEvent.deleteMany({}),/append-only/);
});
test('durable export recovers from delivery failure and avoids resending acknowledged events',async()=>{
 const {MongoMemoryServer}=await import('mongodb-memory-server');
 const {default:mongoose}=await import('mongoose');
 const {recordSecurityEvent,exportSecurityEvents}=await import('../src/services/securityAuditService.js');
 const {SecurityEventDelivery}=await import('../src/models/SecurityEvent.model.js');
 const db=await MongoMemoryServer.create();
 try{
  await mongoose.connect(db.getUri());
  const event=await recordSecurityEvent({user:{_id:'staff',role:'admin'},requestId:'request'}, {action:'DOWNLOAD_AUTHORIZED',transferId:'transfer'});
  await exportSecurityEvents({send:async()=>{throw new Error('offline');}});
  assert.equal((await SecurityEventDelivery.findById(event.eventId)).exportedAt,undefined);
  await SecurityEventDelivery.updateOne({_id:event.eventId},{$set:{nextAttemptAt:new Date(0)}});
  let count=0;
  await exportSecurityEvents({send:async item=>{assert.equal(item.eventId,event.eventId);count++;}});
  await exportSecurityEvents({send:async()=>{count++;}});
  assert.equal(count,1);
 }finally{await mongoose.disconnect();await db.stop();}
});
