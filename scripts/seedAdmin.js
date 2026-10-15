import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { StaffUser } from '../src/models/StaffUser.model.js';

const uri = process.env.ATLAS_MONGODB_URI || process.env.MONGODB_URI;
if (!uri || !new URL(uri).hostname.endsWith('.mongodb.net')) {
  throw new Error('Admin seed requires an Atlas MONGODB_URI');
}

const email = (process.env.ADMIN_SEED_EMAIL || 'admin@tinzel.com').trim().toLowerCase();
const name = (process.env.ADMIN_SEED_NAME || 'System Admin').trim();
if (!email || !name) throw new Error('Admin email and name are required');

await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
try {
  const existing = await StaffUser.findOne({ email }).select('role isActive');
  if (existing) {
    console.log(JSON.stringify({ created: false, database: mongoose.connection.name, email, role: existing.role, isActive: existing.isActive }));
  } else {
    const password = process.env.ADMIN_SEED_PASSWORD || randomBytes(24).toString('base64url');
    const admin = await StaffUser.create({
      name,
      email,
      passwordHash: await bcrypt.hash(password, 12),
      role: 'admin',
      isActive: true,
      isEligibleForAssignment: false,
      maxActiveWorkload: 0,
    });
    const verified = await StaffUser.findById(admin._id);
    if (!verified || verified.role !== 'admin' || !verified.isActive || !(await verified.comparePassword(password))) {
      throw new Error('Admin account was created but verification failed');
    }
    console.log(JSON.stringify({ created: true, database: mongoose.connection.name, email, role: verified.role, isActive: verified.isActive, temporaryPassword: password }));
  }
} finally {
  await mongoose.disconnect();
}
