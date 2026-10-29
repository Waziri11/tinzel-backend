import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../src/config/db.js';
import { runDraftOutbox } from '../src/services/draftOutboxService.js';
if(!await connectDB())throw new Error('Outbox worker needs a database connection');
let stopped=false;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>stopped=true);
try{do{await runDraftOutbox({limit:10});if(!stopped)await new Promise(r=>setTimeout(r,1000));}while(!stopped&&!process.argv.includes('--once'));}
finally{await mongoose.disconnect();}
