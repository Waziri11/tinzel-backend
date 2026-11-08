import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Order } from '../src/models/Order.model.js';
import { standardDeadline } from '../src/services/expressOrderService.js';
import { backfillStandardCountdowns } from '../src/services/standardCountdownBackfill.js';
let db;
before(async () => { db = await MongoMemoryServer.create(); await mongoose.connect(db.getUri()); });
after(async () => { await mongoose.disconnect(); await db?.stop(); });

test('legacy backfill uses original payment, preserves existing clocks and history, and is idempotent', async () => {
  const paidAt = new Date('2026-11-06T10:15:00+03:00'), updatedAt = new Date('2026-11-07T12:00:00Z');
  const oldStart = new Date('2026-11-05T10:15:00+03:00'), oldDue = standardDeadline(oldStart);
  const base = { __v: 4, isExpress: false, status: 'in_design', updatedAt, paymentDetails: { verifiedAt: paidAt }, workflowEvents: [{ event: 'unchanged' }] };
  const docs = [
    { ...base }, { ...base, standardStartedAt: oldStart }, { ...base, standardDueAt: oldDue },
    { ...base, standardStartedAt: oldStart, standardDueAt: oldDue },
    { ...base, isExpress: true }, { ...base, paymentDetails: {} }, { ...base, retentionDeletingAt: new Date() },
  ].map(doc => ({ ...doc, _id: new mongoose.Types.ObjectId() }));
  await Order.collection.insertMany(docs);
  assert.deepEqual(await backfillStandardCountdowns(), { candidates: 3, updated: 0, conflicts: 0, invalid: 0, applied: false });
  assert.equal((await Order.collection.findOne({ _id: docs[0]._id })).standardDueAt, undefined);
  assert.deepEqual(await backfillStandardCountdowns({ apply: true }), { candidates: 3, updated: 3, conflicts: 0, invalid: 0, applied: true });
  for (let i = 0; i < docs.length; i++) {
    const saved = await Order.collection.findOne({ _id: docs[i]._id });
    assert.equal(+saved.updatedAt, +updatedAt);
    assert.deepEqual(saved.workflowEvents, docs[i].workflowEvents);
    assert.equal(+saved.paymentDetails.verifiedAt, +docs[i].paymentDetails.verifiedAt);
    if (i < 3) {
      assert.equal(+saved.standardStartedAt, +(docs[i].standardStartedAt || paidAt));
      assert.equal(+saved.standardDueAt, +(docs[i].standardDueAt || standardDeadline(saved.standardStartedAt)));
      assert.equal(saved.__v, 5);
    } else assert.deepEqual(saved, docs[i]);
  }
  assert.equal((await backfillStandardCountdowns({ apply: true })).candidates, 0);
});
