import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../src/config/db.js';
import { runProofJobs } from '../src/services/proofWorkerService.js';
if(!await connectDB())throw new Error('Proof worker needs a database connection');
let stopped=false;const context=new Map();
process.on('SIGTERM',()=>stopped=true);process.on('SIGINT',()=>stopped=true);
try{
 do{
   const result=await runProofJobs({maxJobs:6,budgetMs:230000,context,retainContext:true});
   if(!result.processed){for(const pdf of context.values())await pdf.destroy().catch(()=>{});context.clear();await new Promise(r=>setTimeout(r,250));}
 }while(!stopped&&!process.argv.includes('--once'));
}finally{for(const pdf of context.values())await pdf.destroy().catch(()=>{});await mongoose.disconnect();}
