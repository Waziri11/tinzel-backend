import { Order } from '../models/Order.model.js';
import { standardDeadline } from './expressOrderService.js';

// Fill missing clocks from the original payment timestamp without workflow events,
// notifications, changes to updatedAt, or overwriting an existing deadline.
export async function backfillStandardCountdowns({ apply = false } = {}) {
  const query = { isExpress: { $ne: true }, retentionDeletingAt: null,
    'paymentDetails.verifiedAt': { $type: 'date' },
    $or: [{ standardStartedAt: null }, { standardDueAt: null }],
  };
  const result = { candidates: 0, updated: 0, conflicts: 0, invalid: 0, applied: apply };
  const cursor = Order.collection.find(query, { projection: { __v: 1, standardStartedAt: 1, standardDueAt: 1, 'paymentDetails.verifiedAt': 1 } });
  for await (const order of cursor) {
    result.candidates++;
    let standardStartedAt, standardDueAt;
    try {
      standardStartedAt = order.standardStartedAt || order.paymentDetails.verifiedAt;
      standardDueAt = order.standardDueAt || standardDeadline(standardStartedAt);
      if (!Number.isFinite(+new Date(standardStartedAt)) || !Number.isFinite(+new Date(standardDueAt))) throw new Error('Invalid clock');
    } catch { result.invalid++; continue; }
    if (!apply) continue;
    const update = await Order.collection.updateOne({ ...query, _id: order._id, __v: order.__v ?? null }, {
      $set: { standardStartedAt, standardDueAt }, $inc: { __v: 1 },
    });
    if (update.modifiedCount) result.updated++; else result.conflicts++;
  }
  return result;
}
