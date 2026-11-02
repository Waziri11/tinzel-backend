import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { provisionAdmin } from '../scripts/lib/adminSeed.js';
import { StaffUser } from '../src/models/StaffUser.model.js';
import { AccessSession, AccessChallenge } from '../src/models/AccessSession.model.js';
import { AuditLog } from '../src/models/AuditLog.model.js';

test('admin provisioning creates expiring setup credentials and explicitly resets only the target admin', async () => {
  const db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  try {
    await mongoose.connect(db.getUri());
    await Promise.all([StaffUser.init(), AccessSession.init(), AccessChallenge.init(), AuditLog.init()]);
    const args = { email: 'seed@example.test', phone: '0712000001' };
    const first = await provisionAdmin(args);
    let user = await StaffUser.findOne({ email: args.email });
    assert.equal(first.created, true);assert.equal(user.mustChangePassword, true);
    assert.ok(await user.comparePassword(first.temporaryPassword));
    assert.ok(user.temporaryPasswordExpiresAt > Date.now() + 23 * 3600000);
    await AccessSession.create({ _id: 'old-session', kind: 'staff', subjectId: String(user._id), expiresAt: new Date(Date.now() + 3600000) });
    await AccessChallenge.create({ _id: 'old-challenge', subjectId: String(user._id), expiresAt: new Date(Date.now() + 3600000) });
    await assert.rejects(provisionAdmin(args), /already exists/);
    const second = await provisionAdmin({ ...args, phone: '0712000002', resetExisting: true });
    user = await StaffUser.findById(user._id);
    assert.equal(second.created, false);assert.equal(user.phone, '0712000002');
    assert.equal(await user.comparePassword(first.temporaryPassword), false);
    assert.equal(await user.comparePassword(second.temporaryPassword), true);
    assert.equal(await AccessSession.countDocuments(), 0);
    assert.ok((await AccessChallenge.findById('old-challenge')).consumedAt);
    assert.equal(await StaffUser.countDocuments(), 1);
    assert.equal(await AuditLog.countDocuments(), 2);
    assert.ok(!JSON.stringify(await AuditLog.find()).includes(second.temporaryPassword));
    const original = AuditLog.create;AuditLog.create = async () => { throw new Error('Audit unavailable'); };
    try { await assert.rejects(provisionAdmin({ ...args, resetExisting: true }), /Audit unavailable/); }
    finally { AuditLog.create = original; }
    assert.ok(await (await StaffUser.findById(user._id)).comparePassword(second.temporaryPassword));
    await StaffUser.updateOne({_id:user._id},{$set:{role:'manager'}});
    await assert.rejects(provisionAdmin({...args,resetExisting:true}),/implicit privilege change/);
    assert.equal((await StaffUser.findById(user._id)).role,'manager');
    const promoted=await provisionAdmin({...args,resetExisting:true,promoteExisting:true});
    assert.equal(promoted.role,'admin');assert.equal(await StaffUser.countDocuments(),1);
    assert.ok(await AuditLog.exists({action:'ADMIN_ACCOUNT_PROMOTED','details.previousRole':'manager'}));
  } finally { await mongoose.disconnect();await db.stop(); }
});
