import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import { DraftUpload } from '../models/DraftUpload.model.js';
import { Order } from '../models/Order.model.js';
import { AuditLog } from '../models/AuditLog.model.js';
import { activeRevisionRequest, assertExpectedVersion } from './revisionRequestService.js';
import { enqueueProof } from './proofReaderService.js';
import { notifyDraftUploaded } from './notificationService.js';

export const DRAFT_CHUNK_BYTES = 1024 * 1024;
export const MAX_DRAFT_BYTES = 500 * 1024 * 1024;
const collection = (name) => mongoose.connection.db.collection(`draftFiles.${name}`);
export function draftError(status, message) { return Object.assign(new Error(message), { status }); }
export function validateDraftGate(order, input) {
  if (!['assigned', 'in_design', 'revision_requested'].includes(order.status)) throw draftError(409, `A draft cannot be uploaded while the order is ${order.status.replaceAll('_',' ')}`);
  if (!Number.isInteger(input.expectedVersion)) throw draftError(400, 'Current draft version is required');
  assertExpectedVersion(order, input.expectedVersion);
  const active = activeRevisionRequest(order);
  if (active?.status === 'submitted_for_review') throw draftError(409, 'This return is already awaiting manager review');
  if (active && (String(input.revisionRequestId || '') !== String(active._id) || input.verifyAll !== true || active.items.some((item) => item.status !== 'addressed'))) throw draftError(409, 'Address and verify every requested fix before uploading');
  return active;
}
export async function createDraftUpload(order, user, input) {
  validateDraftGate(order, input);
  if (!Number.isSafeInteger(input.size) || input.size < 5 || input.size > MAX_DRAFT_BYTES) throw draftError(413, 'Magazine PDFs must be at most 500 MB');
  if (!String(input.name || '').toLowerCase().endsWith('.pdf') || input.contentType !== 'application/pdf' || !/^[a-f0-9]{64}$/.test(input.fingerprint || '')) throw draftError(400, 'Choose a valid PDF file');
  await collection('chunks').createIndex({ files_id: 1, n: 1 }, { unique: true });
  return DraftUpload.create({ orderId: order._id, staffId: user._id, assetId: new mongoose.Types.ObjectId(), name: String(input.name).slice(0,255), size: input.size,
    fingerprint: input.fingerprint, expectedVersion: input.expectedVersion, designerNotes: String(input.designerNotes || '').slice(0,8000),
    revisionRequestId: input.revisionRequestId, verifyAll: input.verifyAll === true, expiresAt: new Date(Date.now()+86400000) });
}
export async function getDraftUpload(id, orderId, staffId, allowClosed = false) {
  if (!mongoose.isValidObjectId(id)) throw draftError(404, 'Upload session not found');
  const session = await DraftUpload.findOne({ _id: id, orderId, staffId });
  if (!session) throw draftError(404, 'Upload session not found');
  if (!allowClosed && session.state !== 'complete' && (session.expiresAt < new Date() || ['cancelled','expired'].includes(session.state))) throw draftError(410, 'This upload expired or was cancelled. Start a new upload.');
  return session;
}
export async function draftUploadStatus(session) {
  const chunks = await collection('chunks').find({ files_id: session.assetId }, { projection: { n:1, length:1, sha256:1, _id:0 } }).sort({ n:1 }).toArray();
  return { id: session._id, state:session.state, name:session.name, size:session.size, fingerprint:session.fingerprint,
    expiresAt:session.expiresAt, chunkBytes:DRAFT_CHUNK_BYTES, chunks, version:session.version };
}
export async function writeDraftChunk(session, n, bytes, suppliedHash) {
  if (session.state !== 'open') throw draftError(409,'Upload is not accepting more parts');
  const expected = Math.min(DRAFT_CHUNK_BYTES, session.size-n*DRAFT_CHUNK_BYTES);
  if (!Number.isInteger(n) || n < 0 || n >= Math.ceil(session.size/DRAFT_CHUNK_BYTES) || !Buffer.isBuffer(bytes) || bytes.length !== expected) throw draftError(400,'Invalid upload part');
  const sha256=createHash('sha256').update(bytes).digest('hex');
  if (suppliedHash !== sha256) throw draftError(409,'Upload part verification failed. Retry this part.');
  if (!n && bytes.subarray(0,5).toString() !== '%PDF-') throw draftError(400,'The selected file is not a PDF');
  const filter={files_id:session.assetId,n};
  try { await collection('chunks').updateOne(filter,{$setOnInsert:{...filter,data:bytes,length:bytes.length,sha256}},{upsert:true}); }
  catch(e) { if(e.code!==11000)throw e; }
  const stored=await collection('chunks').findOne(filter,{projection:{sha256:1}});
  if(stored.sha256!==sha256)throw draftError(409,'This part differs from the original upload. Select the same file or start again.');
  await DraftUpload.updateOne({_id:session._id,state:'open'},{$set:{expiresAt:new Date(Date.now()+86400000)}});
}
export async function finishDraftUpload(session, user) {
  // The order is the durable receipt if the final response/session update was interrupted.
  let order=await Order.findById(session.orderId);
  let committed=order?.draftVersions.find((v)=>String(v.uploadSessionId)===String(session._id));
  if(committed){await DraftUpload.updateOne({_id:session._id},{$set:{state:'complete',version:committed.versionNumber}});await enqueueProof(order._id,committed.versionNumber);return {success:true,order,version:committed.versionNumber};}
  const claimed=await DraftUpload.findOneAndUpdate({_id:session._id,expiresAt:{$gt:new Date()},$or:[{state:'open'},{state:'finalizing',leaseUntil:{$lt:new Date()}}]},{$set:{state:'finalizing',leaseUntil:new Date(Date.now()+60000)}},{returnDocument:'after'});
  if(!claimed)throw draftError(409,'Upload is being finalized. Retry shortly to retrieve its result.');
  try {
    const active=validateDraftGate(order,claimed);
    const parts=await collection('chunks').find({files_id:claimed.assetId},{projection:{n:1,length:1,_id:0}}).sort({n:1}).toArray();
    if(parts.length!==Math.ceil(claimed.size/DRAFT_CHUNK_BYTES)||parts.some((p,n)=>p.n!==n||p.length!==Math.min(DRAFT_CHUNK_BYTES,claimed.size-n*DRAFT_CHUNK_BYTES)))throw draftError(409,'Upload is incomplete. Resume the missing parts.');
    const first=await collection('chunks').findOne({files_id:claimed.assetId,n:0});
    if(Buffer.from(first.data.buffer).subarray(0,5).toString()!=='%PDF-')throw draftError(400,'The uploaded file is not a PDF');
    const version=(order.currentDraftVersion||0)+1;
    await collection('files').updateOne({_id:claimed.assetId},{$setOnInsert:{length:claimed.size,chunkSize:DRAFT_CHUNK_BYTES,uploadDate:new Date(),filename:claimed.name,contentType:'application/pdf',metadata:{orderId:String(order._id),versionNumber:version}}},{upsert:true});
    order.draftVersions.push({versionNumber:version,assetId:claimed.assetId,uploadSessionId:claimed._id,originalName:claimed.name,mimeType:'application/pdf',size:claimed.size,revisionRequestId:active?._id,uploadedBy:user._id,uploadedAt:new Date(),designerNotes:claimed.designerNotes,managerReview:{status:'pending'}});
    if(active){active.status='submitted_for_review';active.submittedVersionNumber=version;active.submittedAt=new Date();}
    order.currentDraftVersion=version;order.status='draft_manager_review';await order.save();committed=order.draftVersions.at(-1);
    await DraftUpload.updateOne({_id:claimed._id},{$set:{state:'complete',version}});
    await AuditLog.create({actor:{type:user.role,id:user._id,name:user.name},action:'DRAFT_UPLOADED',orderId:order._id,details:{versionNumber:version,uploadSessionId:String(claimed._id),revisionRequestId:active?._id}});
    await enqueueProof(order._id,version);
    await notifyDraftUploaded(order,version);
    return {success:true,order,version};
  } catch(e) {
    if(!committed)await DraftUpload.updateOne({_id:claimed._id,state:'finalizing'},{$set:{state:'open'}});
    throw e;
  }
}
export async function cleanExpiredDraftUploads() {
  const sessions=await DraftUpload.find({state:{$ne:'complete'},expiresAt:{$lt:new Date()},$or:[{state:{$ne:'finalizing'}},{leaseUntil:{$lt:new Date()}}]}).limit(10);
  for(const session of sessions){
    const receipt=await Order.findOne({'draftVersions.uploadSessionId':session._id}).select('draftVersions.versionNumber draftVersions.uploadSessionId');
    if(receipt){const version=receipt.draftVersions.find((v)=>String(v.uploadSessionId)===String(session._id)).versionNumber;await DraftUpload.updateOne({_id:session._id},{$set:{state:'complete',version}});continue;}
    await DraftUpload.updateOne({_id:session._id},{$set:{state:'expired'}});
    await collection('files').deleteOne({_id:session.assetId});await collection('chunks').deleteMany({files_id:session.assetId});
    await DraftUpload.deleteOne({_id:session._id,state:'expired'});
  }
}
