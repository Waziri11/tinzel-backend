import 'dotenv/config';
import mongoose from 'mongoose';
import { backfillBalancePayments } from '../src/services/balancePaymentBackfill.js';

const apply = process.argv.includes('--apply');
try {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI must be configured.');
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000, maxPoolSize: 2 });
  console.log(JSON.stringify({ apply, ...await backfillBalancePayments({ apply }) }));
} catch (error) {
  console.error(JSON.stringify({ error: 'Balance payment backfill failed', name: error.name, code: error.code }));
  process.exitCode = 1;
} finally { await mongoose.disconnect(); }
