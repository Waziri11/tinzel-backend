import 'dotenv/config';
import mongoose from 'mongoose';
import { backfillStandardCountdowns } from '../src/services/standardCountdownBackfill.js';

try {
  if (!process.env.MONGODB_URI) throw new Error('Database configuration is required');
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000, maxPoolSize: 2 });
  console.log(JSON.stringify(await backfillStandardCountdowns({ apply: process.argv.includes('--apply') })));
} catch (error) {
  console.error(JSON.stringify({ error: 'Standard countdown backfill failed', name: error.name, code: error.code }));
  process.exitCode = 1;
} finally { await mongoose.disconnect(); }
