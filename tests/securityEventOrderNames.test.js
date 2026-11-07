import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Order } from '../src/models/Order.model.js';
import { securityEventsWithOrderNames } from '../src/services/securityEventOrderNames.js';

test('audit display resolves current and legacy references without changing stored event identities', async () => {
  const db = await MongoMemoryServer.create();
  try {
    await mongoose.connect(db.getUri());
    const first = new mongoose.Types.ObjectId(), second = new mongoose.Types.ObjectId();
    await Order.collection.insertMany([
      {_id:first,clientName:'Asha Mushi',trackingId:'TNZ-2026-1',submissionId:'SUB-2026-1'},
      {_id:second,clientName:'Asha Mushi',trackingId:'TNZ-2026-2'},
    ]);
    const events = [String(first),'TNZ-2026-1','SUB-2026-1',String(second),'TNZ-DELETED'].map((orderId,i)=>({eventId:String(i),orderId}));
    const result = await securityEventsWithOrderNames(events);
    assert.deepEqual(result.map(event=>event.orderClientName), ['Asha Mushi','Asha Mushi','Asha Mushi','Asha Mushi',null]);
    assert.deepEqual(result.map(event=>event.orderId),events.map(event=>event.orderId));
    assert.ok(events.every(event=>!('orderClientName' in event)));
  } finally { await mongoose.disconnect(); await db.stop(); }
});
