import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {MongoMemoryServer} from 'mongodb-memory-server';
import {MediaJob} from '../src/models/Media.model.js';
import {runProofJobs} from '../src/services/proofWorkerService.js';
import {proofDiagnostic} from '../src/services/proofDiagnostics.js';
let mongo;before(async()=>{mongo=await MongoMemoryServer.create();await mongoose.connect(mongo.getUri());});after(async()=>{await mongoose.disconnect();await mongo.stop();});
test('proof jobs bypass the archive lock, prioritize requested pages, and lease each job once',async()=>{
 await MediaJob.create({_id:'worker-lock',kind:'lock',leaseUntil:new Date(Date.now()+60000)});
 for(const [page,priority] of [[5,100],[1,400]])await MediaJob.create({_id:`priority-${page}`,kind:'proof',requested:true,page,priority});
 const built=[];const build=async job=>{built.push(job.page);await new Promise(r=>setTimeout(r,10));};
 await runProofJobs({maxJobs:1,build});assert.deepEqual(built,[1]);
 await Promise.all([runProofJobs({maxJobs:1,build}),runProofJobs({maxJobs:1,build})]);assert.deepEqual(built,[1,5]);assert.equal(await MediaJob.countDocuments({kind:'proof',state:'ready'}),2);
});
test('deterministic errors retain diagnostics and transient lease failures recover',async()=>{
 await MediaJob.create({_id:'invalid-pdf',kind:'proof',requested:true,page:1});
 await runProofJobs({maxJobs:1,build:async()=>{throw Object.assign(new Error('Invalid PDF structure'),{name:'InvalidPDFException'});}});
 const invalid=await MediaJob.findById('invalid-pdf');assert.equal(invalid.state,'failed');assert.equal(invalid.errorCode,'PROOF_PDF_INVALID');assert.ok(invalid.errorReference);assert.equal(invalid.attemptHistory.filter(a=>a.state==='failed').length,1);
 await MediaJob.create({_id:'abandoned',kind:'proof',requested:true,state:'running',attempts:1,leaseUntil:new Date(0)});
 let attempts;await runProofJobs({maxJobs:1,build:async job=>{attempts=job.attempts;}});assert.equal(attempts,2);assert.equal((await MediaJob.findById('abandoned')).state,'ready');
 await MediaJob.create({_id:'lost',kind:'proof',requested:true,state:'running',attempts:3,leaseUntil:new Date(0)});
 await runProofJobs({maxJobs:1,build:async()=>{throw new Error('Must not run');}});assert.equal((await MediaJob.findById('lost')).errorCode,'PROOF_LEASE_LOST');
});
test('diagnostics distinguish source, dependency, password, memory, timeout and lease failures',()=>{
 for(const [error,code] of [[{status:404,message:'not found'},'PROOF_SOURCE_UNAVAILABLE'],[{message:'Cannot find native canvas module'},'PROOF_RENDERER_UNAVAILABLE'],[{name:'PasswordException',message:'password'},'PROOF_PDF_ENCRYPTED'],[{message:'heap out of memory'},'PROOF_MEMORY_LIMIT'],[{name:'TimeoutError',message:'timeout'},'PROOF_TIMEOUT'],[{message:'Worker lease lost'},'PROOF_LEASE_LOST']])assert.equal(proofDiagnostic(error).errorCode,code);
 assert.doesNotMatch(proofDiagnostic(new Error('mongodb://user:secret@host/db Bearer secret')).error,/secret/);
});
