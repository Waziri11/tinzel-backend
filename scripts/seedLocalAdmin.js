import 'dotenv/config';
import mongoose from 'mongoose';

const sourceUri = process.env.ATLAS_MONGODB_URI || process.env.MONGODB_URI;
const localUri = process.env.LOCAL_MONGODB_URI || 'mongodb://127.0.0.1:27017/tinzel';
const email = (process.env.ADMIN_SEED_EMAIL || 'admin@tinzel.com').trim().toLowerCase();

const sourceUrl = new URL(sourceUri || 'mongodb://invalid');
const localUrl = new URL(localUri);
if (!sourceUrl.hostname.endsWith('.mongodb.net')) {
  throw new Error('ATLAS_MONGODB_URI must point to the live Atlas database');
}
if (!['localhost', '127.0.0.1', '::1'].includes(localUrl.hostname)) {
  throw new Error('LOCAL_MONGODB_URI must point to a local MongoDB server');
}
if (!email) throw new Error('ADMIN_SEED_EMAIL is required');

const source = mongoose.createConnection(sourceUri, { serverSelectionTimeoutMS: 10000 });
const local = mongoose.createConnection(localUri, { serverSelectionTimeoutMS: 10000 });
try {
  await Promise.all([source.asPromise(), local.asPromise()]);
  const admin = await source.collection('staffusers').findOne({ email, role: 'admin', isActive: true, deletedAt: null });
  if (!admin?.passwordHash) throw new Error('Active live admin account was not found');

  await local.collection('staffusers').updateOne(
    { email },
    {
      $set: {
        name: admin.name,
        email: admin.email,
        passwordHash: admin.passwordHash,
        role: 'admin',
        phone: admin.phone || '',
        isActive: true,
        deletedAt: null,
        isEligibleForAssignment: false,
        maxActiveWorkload: 0,
        currentActiveWorkload: 0,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );

  const seeded = await local.collection('staffusers').findOne({ email });
  if (seeded?.passwordHash !== admin.passwordHash || seeded.role !== 'admin' || !seeded.isActive) {
    throw new Error('Local admin verification failed');
  }
  console.log(JSON.stringify({ email, database: local.name, role: seeded.role, verified: true }));
} finally {
  await Promise.all([source.close(), local.close()]);
}
