import mongoose from 'mongoose';
import { Order } from '../models/Order.model.js';
import { StaffUser } from '../models/StaffUser.model.js';
import { AuditLog } from '../models/AuditLog.model.js';

const deletionAction = 'SUBMISSION_DELETION_REQUESTED';
const fail = (status, message) => Object.assign(new Error(message), { status });

export async function requestSubmissionDeletion(id, actor, ipAddress) {
  if (actor?.role !== 'admin') throw fail(403, 'Only an administrator can delete submissions.');
  if (!mongoose.isObjectIdOrHexString(id)) throw fail(404, 'Submission not found.');
  const orderId = new mongoose.Types.ObjectId(id);

  return mongoose.connection.transaction(async session => {
    // Include already-hidden submissions so retries cannot release workload twice.
    const order = await Order.collection.findOne({ _id: orderId }, { session });
    if (!order) {
      const receipt = await AuditLog.findOne({ action: deletionAction, 'details.deletedOrderId': String(orderId) }).session(session);
      if (receipt) return { state: 'deleted' };
      throw fail(404, 'Submission not found.');
    }
    if (order.retentionDeletingAt) return { state: 'deleting' };

    // Retention guards hide the submission and reject stale in-flight saves.
    // Scheduled cleanup waits for uploads/workers to drain before erasing files.
    await Order.collection.updateOne({ _id: orderId }, {
      $set: { retentionDeletingAt: new Date() }, $inc: { __v: 1 },
    }, { session });
    if (order.assignedDesigner && order.status !== 'closed') {
      await StaffUser.updateOne({ _id: order.assignedDesigner }, [
        { $set: { currentActiveWorkload: { $max: [0, { $subtract: [{ $ifNull: ['$currentActiveWorkload', 0] }, 1] }] } } },
      ], { session, updatePipeline: true });
    }
    // Keep a minimal administrative receipt after submission history is erased.
    // Omit orderId and customer details from this account-level audit entry.
    await AuditLog.create([{
      actor: { type: 'admin', id: String(actor._id), name: actor.name },
      action: deletionAction,
      details: { deletedOrderId: String(orderId), previousStatus: order.status },
      ipAddress,
    }], { session });
    return { state: 'deleting' };
  });
}
