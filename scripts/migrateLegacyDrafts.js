import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { connectDB } from '../src/config/db.js';
import { Order } from '../src/models/Order.model.js';
import { saveDraftPdf } from '../src/services/draftFileService.js';
import { createRevisionRequest } from '../src/services/revisionRequestService.js';

if (!await connectDB()) throw new Error('Database connection is required');
const orders = await Order.find({ $or: [{ 'draftVersions.assetId': { $exists: false } }, { status: 'revision_requested' }, { status: 'in_design', 'draftVersions.managerReview.status': 'returned' }] });
let migrated = 0; let missing = 0; let returns = 0;
for (const order of orders) {
  let changed = false;
  for (const draft of order.draftVersions) {
    if (draft.assetId || !draft.fileUrl?.startsWith('/uploads/drafts/')) continue;
    try {
      const buffer = await fs.readFile(path.join(process.cwd(), draft.fileUrl.replace(/^\//, '')));
      if (buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('not a PDF');
      draft.assetId = await saveDraftPdf({ buffer, originalname: path.basename(draft.fileUrl), mimetype: 'application/pdf', size: buffer.length }, order._id, draft.versionNumber);
      draft.originalName = path.basename(draft.fileUrl); draft.size = buffer.length; changed = true; migrated += 1;
    } catch { missing += 1; }
  }
  const active = order.revisionRequests?.some((request) => request.status !== 'resolved');
  const current = order.draftVersions.find((draft) => draft.versionNumber === order.currentDraftVersion);
  const legacyReturnActive = order.status === 'revision_requested' || (order.status === 'in_design' && current?.managerReview?.status === 'returned');
  if (legacyReturnActive && !active) {
    const feedback = current?.clientReview?.feedback || current?.managerReview?.feedback || 'Legacy revision request';
    createRevisionRequest(order, { source: current?.clientReview?.status === 'revision_requested' ? 'client' : 'manager', actor: { type: current?.clientReview?.status === 'revision_requested' ? 'client' : 'manager', name: 'Legacy workflow' }, items: [{ text: feedback }] });
    changed = true; returns += 1;
  }
  if (changed) await order.save();
}
console.log(JSON.stringify({ orders: orders.length, migratedDrafts: migrated, missingLegacyFiles: missing, backfilledReturns: returns }, null, 2));
await mongoose.disconnect();
