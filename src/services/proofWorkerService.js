import { randomUUID } from 'node:crypto';
import { MediaJob } from '../models/Media.model.js';
import { buildProof } from './proofReaderService.js';
import { proofDiagnostic } from './proofDiagnostics.js';

export async function runProofJobs({ maxJobs = 6, budgetMs = 230000, filter = {}, context = new Map(), retainContext = false, build = buildProof } = {}) {
  const owner = randomUUID(), started = Date.now(); let processed = 0;
  // A crashed process consumes its attempt; preserve that reason before the next lease.
  await MediaJob.updateMany({ kind:'proof', state:'running', leaseUntil:{$lt:new Date()}, attempts:{$gte:3} },
    {$set:{state:'failed',...proofDiagnostic(Object.assign(new Error('Worker exited or lost its lease'),{code:'PROOF_LEASE_LOST'}))}});
  try {
    while (processed < maxJobs && Date.now() - started < budgetMs - 1000) {
      const now = new Date(), outputId = randomObjectId();
      const job = await MediaJob.findOneAndUpdate({ kind:'proof', requested:true, ...filter, attempts:{$lt:3},
        $or:[{state:'queued',runAfter:{$lte:now}},{state:'running',leaseUntil:{$lt:now}}] },
      {$set:{state:'running',owner,leaseUntil:new Date(Date.now()+60000),outputId},$push:{outputIds:outputId,attemptHistory:{$each:[{state:'leased',owner,at:now}],$slice:-30}},$inc:{attempts:1}},
      {sort:{priority:-1,createdAt:1},returnDocument:'after'}).lean();
      if (!job) break;
      const controller=new AbortController(), jobStarted=performance.now();
      const deadline=AbortSignal.timeout(Math.min(120000,Math.max(1,budgetMs-(Date.now()-started))));
      const signal=AbortSignal.any([controller.signal,deadline]);
      const heartbeat=setInterval(async()=>{
        try {
          const result=await MediaJob.updateOne({_id:job._id,owner,state:'running'},{$set:{leaseUntil:new Date(Date.now()+60000)}});
          if(!result.matchedCount)controller.abort(Object.assign(new Error('Worker lease lost'),{code:'PROOF_LEASE_LOST'}));
        }catch(e){controller.abort(e);}
      },10000);
      try {
        await build(job,signal,context);
        signal.throwIfAborted();
        const updated=await MediaJob.updateOne({_id:job._id,owner,state:'running'},{$set:{state:'ready',completedAt:new Date(),error:'',errorCode:null,errorReference:null},$push:{attemptHistory:{attempt:job.attempts,state:'ready',at:new Date(),durationMs:Math.round(performance.now()-jobStarted)}}});
        if(!updated.matchedCount)throw Object.assign(new Error('Worker lease lost'),{code:'PROOF_LEASE_LOST'});
      }catch(error){
        const diagnostic=proofDiagnostic(error);
        await MediaJob.updateOne({_id:job._id,owner,state:'running'},{$set:{...diagnostic,state:diagnostic.retryable&&job.attempts<3?'queued':'failed',runAfter:new Date(Date.now()+1000*2**job.attempts)},
          $push:{attemptHistory:{attempt:job.attempts,state:'failed',at:new Date(),...diagnostic}}});
      }finally{
        clearInterval(heartbeat);processed++;
        console.info(JSON.stringify({event:'proof_job',job:job._id,queueWaitMs:jobStarted?Math.max(0,Date.now()-+new Date(job.createdAt)-(performance.now()-jobStarted)):0,durationMs:Math.round(performance.now()-jobStarted),rssBytes:process.memoryUsage().rss}));
      }
    }
  }finally{
    if(!retainContext) { for(const pdf of context.values())await pdf.destroy().catch(()=>{});context.clear(); }
  }
  return {processed};
}
import mongoose from 'mongoose';
function randomObjectId(){return new mongoose.Types.ObjectId().toString();}
