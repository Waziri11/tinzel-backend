import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createProofPreparationKick} from '../src/services/proofPreparationService.js';
test('Vercel preparation returns immediately, coalesces requests and serializes PDF work',async()=>{
 let release;const gate=new Promise(r=>release=r),tasks=[],filters=[];let concurrent=0,peak=0;
 const kick=createProofPreparationKick({enabled:()=>true,wait:task=>tasks.push(task),run:async options=>{filters.push(options.filter);peak=Math.max(peak,++concurrent);assert.equal(options.maxJobs,6);assert.ok(options.budgetMs<=45000);await gate;concurrent--;}});
 assert.equal(kick('first',1),true);await Promise.resolve();assert.equal(filters.length,1);
 kick('second',2);kick('second',2);assert.equal(tasks[0],tasks[1]);assert.equal(filters.length,1);
 release();await Promise.all(tasks);assert.equal(peak,1);assert.deepEqual(filters,[{orderId:'first',version:1},{orderId:'second',version:2}]);
});
test('dedicated or local mode does not start a web-request renderer',()=>{
 let started=false;const kick=createProofPreparationKick({enabled:()=>false,wait:()=>{started=true;},run:()=>{started=true;}});assert.equal(kick('order',1),false);assert.equal(started,false);
});
test('a full batch continues requested work within the same bounded continuation',async()=>{
 const tasks=[];let calls=0;const kick=createProofPreparationKick({enabled:()=>true,wait:task=>tasks.push(task),run:async()=>({processed:++calls===1?6:2})});kick('order',1);await tasks[0];assert.equal(calls,2);
});
test('rendering waits for the HTTP response while its continuation is already registered',async()=>{
 let release,ran=false;const response=new Promise(resolve=>release=resolve),tasks=[];const kick=createProofPreparationKick({enabled:()=>true,wait:task=>tasks.push(task),run:async()=>{ran=true;return {processed:0};}});kick('order',1,{startAfter:response});assert.equal(tasks.length,1);await Promise.resolve();assert.equal(ran,false);release();await tasks[0];assert.equal(ran,true);
});
