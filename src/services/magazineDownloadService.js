import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {createWriteStream,createReadStream} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {draftRangeSource} from './draftFileService.js';
import {recordSecurityEvent} from './securityAuditService.js';
export function printSource(order){
 const value=order.printDocument?.url||'';const match=value.match(/^\/api\/public\/drafts\/([a-f0-9]{24})$/i);
 return match?{assetId:match[1]}:value.startsWith('tinzel/drafts/')?{storageProvider:'blob',blobPath:value}:{fileUrl:value};
}
export async function prepareMagazine(source){
 const folder=await mkdtemp(path.join(tmpdir(),'tinzel-private-download-'));const filename=path.join(folder,'magazine.pdf');
 const hash=createHash('sha256');let size=0;
 try{const input=await draftRangeSource(source);await pipeline(input.read(0,input.length),new Transform({transform(chunk,encoding,done){size+=chunk.length;if(size>500*1024*1024)return done(new Error('Magazine exceeds size limit'));hash.update(chunk);done(null,chunk);}}),createWriteStream(filename,{mode:0o600}));return {filename,size,hash:hash.digest('hex'),cleanup:()=>rm(folder,{recursive:true,force:true})};}
 catch(e){await rm(folder,{recursive:true,force:true});throw e;}
}
export async function deliverMagazine(req,res,order,source,{version,expectedHash}={}){
 if(process.env.NODE_ENV==='production' && (!process.env.SECURITY_AUDIT_EXPORT_URL || !process.env.SECURITY_AUDIT_EXPORT_TOKEN))throw Object.assign(new Error('Protected audit export must be configured'),{status:503});
 const prepared=await prepareMagazine(source);const transferId=randomUUID();let bytes=0;
 const details={orderId:String(order._id),version,fileHash:prepared.hash,transferId};
 try{
  if(expectedHash && prepared.hash!==expectedHash)throw Object.assign(new Error('Print file has changed'),{status:403});
  await recordSecurityEvent(req,{...details,action:'DOWNLOAD_AUTHORIZED',outcome:'authorized'});
  res.set({'Content-Type':'application/pdf','Content-Length':String(prepared.size),'Cache-Control':'private, no-store','Content-Disposition':'attachment; filename="tinzel-magazine.pdf"'});
  try{
   await pipeline(createReadStream(prepared.filename),new Transform({transform(chunk,encoding,done){bytes+=chunk.length;done(null,chunk);}}),res);
   await recordSecurityEvent(req,{...details,action:'DOWNLOAD_COMPLETED',outcome:'completed'});
  }catch(e){await recordSecurityEvent(req,{...details,action:'DOWNLOAD_INTERRUPTED',outcome:res.destroyed?'interrupted':'failed'});if(!res.headersSent)throw e;}
 }finally{await prepared.cleanup();}
}
