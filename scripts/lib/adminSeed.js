import { randomInt } from 'node:crypto';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { StaffUser } from '../../src/models/StaffUser.model.js';
import { AccessSession, AccessChallenge } from '../../src/models/AccessSession.model.js';
import { AuditLog } from '../../src/models/AuditLog.model.js';

export async function provisionAdmin({ email, phone, name = 'System Admin', resetExisting = false, promoteExisting = false }) {
  email = String(email || '').trim().toLowerCase();
  phone = String(phone || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A valid admin email is required');
  if (!/^(?:0|\+?255)[67]\d{8}$/.test(phone)) throw new Error('A valid Tanzanian mobile phone is required');
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const password = 'A7!' + Array.from({ length: 13 }, () => alphabet[randomInt(alphabet.length)]).join('') + 'm';
  const passwordHash = await bcrypt.hash(password, 12);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return mongoose.connection.transaction(async (session) => {
    let user = await StaffUser.findOne({ email }).session(session);
    const created = !user;
    const previousRole = user?.role;
    if (user && !resetExisting) throw new Error('Account already exists. Set ADMIN_SEED_RESET_EXISTING=true to explicitly reset it.');
    if (user && user.role !== 'admin' && !promoteExisting) throw new Error('Existing account is not an admin; refusing an implicit privilege change.');
    if (!user) user = new StaffUser({ email, name, passwordHash, role: 'admin' });
    user.set({ phone, passwordHash, role: 'admin', isActive: true, deletedAt: null, isEligibleForAssignment: false,
      mustChangePassword: true, temporaryPasswordExpiresAt: expiresAt, passwordChangedAt: new Date(),
      credentialJob: null, credentialDelivery: { manual: { status: 'issued' } },
      tokenVersion: (user.tokenVersion || 0) + 1, credentialGeneration: (user.credentialGeneration || 0) + 1 });
    await user.save({ session });
    await AccessSession.deleteMany({ kind: 'staff', subjectId: String(user._id) }).session(session);
    await AccessChallenge.updateMany({ subjectId: String(user._id), consumedAt: null }, { $set: { consumedAt: new Date() } }).session(session);
    await AuditLog.create([{ actor: { type: 'system', name: 'Authorized admin provisioning' },
      action: created ? 'ADMIN_ACCOUNT_SEEDED' : previousRole !== 'admin' ? 'ADMIN_ACCOUNT_PROMOTED' : 'ADMIN_INITIAL_PASSWORD_REISSUED',
      details: { staffId: String(user._id), previousRole, role: 'admin', email, phone, mustChangePassword: true, expiresAt } }], { session });
    const verified = await StaffUser.findById(user._id).session(session);
    if (!verified?.isActive || verified.role !== 'admin' || !verified.mustChangePassword || !(await verified.comparePassword(password))) {
      throw new Error('Admin account verification failed');
    }
    return { created, email, phone, role: verified.role, mustChangePassword: true, expiresAt, temporaryPassword: password };
  });
}
