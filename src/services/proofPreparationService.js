import {waitUntil} from '@vercel/functions';
import {runProofJobs} from './proofWorkerService.js';

// Compatibility path for Vercel installations without dedicated workers. Work remains
// leased in MongoDB; waitUntil keeps this bounded task alive after the HTTP response.
// One rendering task per function instance prevents overlapping PDFs exhausting memory.
export function createProofPreparationKick({wait=waitUntil,run=runProofJobs,enabled=()=>process.env.VERCEL==='1'&&process.env.PROOF_WORKER_MODE!=='dedicated',budgetMs=45000}={}){
  let active;const pending=new Map();
  return (orderId,version,{startAfter=Promise.resolve()}={})=>{
    if(!enabled())return false;
    const key=`${orderId}:${version}`;
    if(pending.has(key)||pending.size<8)pending.set(key,{orderId,version});
    if(!active){
      active=Promise.resolve(startAfter).then(async()=>{
        const started=Date.now();
        while(pending.size&&Date.now()-started<budgetMs-1000){
          const [id,filter]=pending.entries().next().value;pending.delete(id);
          const result=await run({maxJobs:6,budgetMs:Math.max(1001,budgetMs-(Date.now()-started)),filter});
          if(result?.processed===6&&!pending.has(id))pending.set(id,filter);
        }
      }).catch(error=>console.error(JSON.stringify({event:'proof_background_failed',name:error.name,code:error.code||'PROOF_RENDER_FAILED'}))).finally(()=>{active=undefined;});
    }
    wait(active);return true;
  };
}
export const scheduleProofPreparation=createProofPreparationKick();

// Register the continuation before sending the response, but release its CPU work only
// after the response has finished (or the connection has closed).
export function afterProofResponse(res){
  return new Promise(resolve=>{
    const done=()=>{res.removeListener('finish',done);res.removeListener('close',done);resolve();};
    res.once('finish',done);res.once('close',done);
  });
}
