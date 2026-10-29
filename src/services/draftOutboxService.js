import { randomUUID } from 'node:crypto';
import { Order } from '../models/Order.model.js';
import { enqueueProof } from './proofReaderService.js';
import { notifyDraftUploaded } from './notificationService.js';
import { AuditLog } from '../models/AuditLog.model.js';

// Events live in the same order write as the new version, so a process exit cannot lose them.
export function draftCommittedEvent(version, user, sessionId) {
  return { key: `draft:${sessionId}`, version, state: 'pending', actor: { type: user.role, id: String(user._id), name: user.name }, createdAt: new Date(), attempts: 0 };
}
export async function runDraftOutbox({ limit = 10 } = {}) {
  let processed = 0;
  const rows = await Order.find({ draftEvents: { $elemMatch: { $or:[{state:'pending',runAfter:{$not:{$gt:new Date()}}},{state:'running',leaseUntil:{$lt:new Date()}}] } } }).select('draftEvents').limit(limit).lean();
  for (const row of rows) for (const event of row.draftEvents || []) {
    if (processed >= limit || event.state === 'done') continue;
    const owner = randomUUID(), now = new Date();
    const claimed = await Order.updateOne({ _id: row._id, draftEvents: { $elemMatch: { key: event.key,
      $or: [{ state: 'pending', runAfter: { $not: { $gt: now } } }, { state: 'running', leaseUntil: { $lt: now } }] } } },
    { $set: { 'draftEvents.$.state': 'running', 'draftEvents.$.owner': owner, 'draftEvents.$.leaseUntil': new Date(Date.now() + 120000) }, $inc: { 'draftEvents.$.attempts': 1 } });
    if (!claimed.modifiedCount) continue;
    try {
      await enqueueProof(row._id, event.version, 0, 300);
      await AuditLog.updateOne({ orderId: row._id, action: 'DRAFT_UPLOADED', 'details.uploadSessionId': event.key.slice(6) },
        { $setOnInsert: { actor: event.actor, orderId: row._id, action: 'DRAFT_UPLOADED', details: { versionNumber: event.version, uploadSessionId: event.key.slice(6) } } }, { upsert: true });
      const order = await Order.findById(row._id);
      await notifyDraftUploaded(order, event.version);
      await Order.updateOne({ _id: row._id, draftEvents: { $elemMatch: { key: event.key, owner } } }, { $set: { 'draftEvents.$.state': 'done', 'draftEvents.$.completedAt': new Date() } });
    } catch (error) {
      await Order.updateOne({ _id: row._id, draftEvents: { $elemMatch: { key: event.key, owner } } }, { $set: { 'draftEvents.$.state': 'pending', 'draftEvents.$.error': String(error.message).slice(0, 500), 'draftEvents.$.runAfter': new Date(Date.now() + 30000) } });
    }
    processed++;
  }
  return { processed };
}
