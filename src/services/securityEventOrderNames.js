import mongoose from 'mongoose';
import { Order } from '../models/Order.model.js';

// Audit records stay immutable; names are resolved only for the staff display.
export async function securityEventsWithOrderNames(events) {
  const references = [...new Set(events.map(event => event.orderId).filter(Boolean).map(String))];
  if (!references.length) return events;
  const ids = references.filter(reference => mongoose.isValidObjectId(reference));
  const orders = await Order.find({ $or: [
    { _id: { $in: ids } }, { trackingId: { $in: references } }, { submissionId: { $in: references } },
  ] }).select('clientName trackingId submissionId').lean();
  const names = new Map();
  for (const order of orders) for (const reference of [order._id, order.trackingId, order.submissionId]) {
    if (reference) names.set(String(reference), order.clientName);
  }
  return events.map(event => ({ ...event, orderClientName: names.get(String(event.orderId)) || null }));
}
