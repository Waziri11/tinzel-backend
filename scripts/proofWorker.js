import 'dotenv/config';
import { fork } from 'node:child_process';
const count=Math.max(1,Math.min(4,Number(process.env.PROOF_PROCESS_COUNT)||2));
const children=new Set();let stopped=false;
function start(script='proofWorkerChild.js'){
 if(stopped)return;
 const child=fork(new URL(`./${script}`,import.meta.url),[],{execArgv:['--max-old-space-size=2048'],stdio:'inherit'});children.add(child);
 child.once('exit',(code,signal)=>{children.delete(child);console.info(JSON.stringify({event:'proof_worker_exit',code,signal}));if(!stopped)setTimeout(()=>start(script),1000);});
}
for(let n=0;n<count;n++)start();
start('draftOutboxWorker.js');
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopped=true;for(const child of children)child.kill(signal);});
