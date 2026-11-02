import 'dotenv/config';
import mongoose from 'mongoose';
import { provisionAdmin } from './lib/adminSeed.js';

const uri = process.env.ATLAS_MONGODB_URI || process.env.MONGODB_URI;
if (!uri || !/^mongodb(?:\+srv)?:\/\//.test(uri) || !new URL(uri).hostname.endsWith('.mongodb.net')) {
  throw new Error('Admin seed requires a live Atlas MONGODB_URI or ATLAS_MONGODB_URI');
}
if (!process.env.ADMIN_SEED_EMAIL || !process.env.ADMIN_SEED_PHONE) {
  throw new Error('ADMIN_SEED_EMAIL and ADMIN_SEED_PHONE are required');
}
await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
try {
  const result = await provisionAdmin({ email: process.env.ADMIN_SEED_EMAIL, phone: process.env.ADMIN_SEED_PHONE,
    name: process.env.ADMIN_SEED_NAME || 'System Admin', resetExisting: process.env.ADMIN_SEED_RESET_EXISTING === 'true' });
  // This local operator output is the only plaintext delivery; never persist it in app logs or git.
  console.log(JSON.stringify({ database: mongoose.connection.name, ...result }));
} finally {
  await mongoose.disconnect();
}
