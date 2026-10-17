import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../src/config/db.js';
import { runMediaJobs, cleanExpiredUploads } from '../src/services/mediaJobService.js';

if (!await connectDB()) throw new Error('Media worker needs a database connection');
const once = process.argv.includes('--once');
let stopped = false;
process.on('SIGTERM', () => { stopped = true; });
process.on('SIGINT', () => { stopped = true; });
try {
  do {
    console.log(await runMediaJobs());
    if (process.env.MEDIA_CLEANUP_ENABLED === 'true') console.log(await cleanExpiredUploads());
    if (!once && !stopped) await new Promise((r) => setTimeout(r, 2000));
  } while (!once && !stopped);
} finally { await mongoose.disconnect(); }
