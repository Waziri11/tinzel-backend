import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../src/config/db.js';
import { runWorkflowNotifications } from '../src/services/workflowNotificationService.js';
if(!await connectDB()) throw new Error('Notification worker needs a database connection');
let stopped=false;
process.on('SIGTERM',()=>{stopped=true;});process.on('SIGINT',()=>{stopped=true;});
try { do {console.log(await runWorkflowNotifications());if(!process.argv.includes('--once')&&!stopped)await new Promise(resolve=>setTimeout(resolve,2000));}while(!stopped&&!process.argv.includes('--once')); }
finally {await mongoose.disconnect();}
