// Isolated browser-test server: never reads .env or connects to customer data.
import mongoose from 'mongoose';
import fs from 'node:fs';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app.js';
import { MagazineForm } from '../src/models/MagazineForm.model.js';
const cache = path.resolve(import.meta.dirname, '../node_modules/.cache/mongodb-memory-server');
const binaryName = fs.existsSync(cache) ? fs.readdirSync(cache).find((name) => name.startsWith(`mongod-${process.arch}-${process.platform}-`)) : null;
const mongo = await MongoMemoryServer.create(binaryName ? { binary: { systemBinary: path.join(cache, binaryName) } } : {});
await mongoose.connect(mongo.getUri());
await MagazineForm.create({ title: 'Upload Performance Test', slug: 'upload-performance-test', isActive: true, price: 50000, currency: 'TZS',
  coverImageUrl: '/brand/magazine-cover-sample.jpg',
  sections: [{ sectionId: 'photos', title: 'Your photographs', order: 0 }],
  fields: ['first', 'second'].map((fieldId, order) => ({ fieldId, sectionId: 'photos', type: 'photo_group', label: `${fieldId} photos`, order, validationRules: { maxPhotos: 100 } })),
  lipaNambaInstructions: { tillNumber: 'TEST', accountName: 'Test only', instructions: 'Do not pay this test order.' },
});
const server = app.listen(5077, '127.0.0.1');
async function stop() { server.closeAllConnections(); await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); process.exit(0); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
