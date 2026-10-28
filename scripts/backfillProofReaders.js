import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../src/config/db.js';
import { Order } from '../src/models/Order.model.js';
import { enqueueProof } from '../src/services/proofReaderService.js';
if (!await connectDB()) throw new Error('Backfill needs a database connection');
try {
  let queued = 0;
  for await (const order of Order.find({ 'draftVersions.0': { $exists: true } }).select('draftVersions.versionNumber').cursor()) {
    for (const draft of order.draftVersions) { await enqueueProof(order._id, draft.versionNumber); queued++; }
  }
  console.log(`Queued protected readers for ${queued} magazine versions. Run the media worker to prepare them.`);
} finally { await mongoose.disconnect(); }
