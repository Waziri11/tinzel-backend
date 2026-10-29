import 'dotenv/config';
import mongoose from 'mongoose';
import { Order } from '../src/models/Order.model.js';
import { MediaJob, ProofPage } from '../src/models/Media.model.js';
import { draftRangeSource } from '../src/services/draftFileService.js';
import { proofDiagnostic } from '../src/services/proofDiagnostics.js';
const [id,versionInput='1']=process.argv.slice(2),version=Number(versionInput);
if(!mongoose.isValidObjectId(id)||!Number.isInteger(version)||version<1)throw new Error('Usage: npm run proof:diagnose -- ORDER_ID VERSION');
try{
 await mongoose.connect(process.env.MONGODB_URI,{autoIndex:false,autoCreate:false,serverSelectionTimeoutMS:10000});
 const order=await Order.findById(id).lean(),draft=order?.draftVersions.find(v=>v.versionNumber===version);
 if(!draft){console.log(JSON.stringify({orderId:id,version,found:false,reason:'No matching version in the configured database'}));process.exitCode=2;}
 else{
  let source;try{const info=await draftRangeSource(draft);let bytes=0;const stream=info.read(0,Math.min(5,info.length));try{for await(const chunk of stream)bytes+=chunk.length;}finally{stream.destroy();}source={available:bytes===Math.min(5,info.length),size:info.length};}catch(e){const d=proofDiagnostic(e);source={available:false,code:d.errorCode,reference:d.errorReference,error:d.error};}
  const jobs=await MediaJob.find({kind:'proof',orderId:id,version}).select('page state attempts error errorCode errorReference errorName attemptHistory leaseUntil createdAt completedAt').lean();
  const pages=await ProofPage.find({orderId:id,version}).select('page width height format renderVersion -_id').lean();
  console.log(JSON.stringify({orderId:id,version,source,jobs,pages,runtime:{node:process.version,platform:process.platform,arch:process.arch,revision:process.env.RENDER_GIT_COMMIT||process.env.VERCEL_GIT_COMMIT_SHA||null}},null,2));
 }
}finally{await mongoose.disconnect();}
