// Disposable acceptance server. It never loads the project's .env or customer database.
import mongoose from 'mongoose';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import bcrypt from 'bcryptjs';
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tinzel-browser-'));
process.chdir(sandbox);
for (const key of Object.keys(process.env)) {
  if (/^(SMTP_|TWILIO_|NEXTSMS_|BLOB_|VERCEL|MONGODB_|FRONTEND_URL|BACKEND_URL|CRON_SECRET)/.test(key)) delete process.env[key];
}
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'isolated-browser-only-secret-never-production-2026';
process.env.DOTENV_CONFIG_PATH = path.join(sandbox, 'absent.env');
const { default: app } = await import('../src/app.js');
const { MagazineForm } = await import('../src/models/MagazineForm.model.js');
const { StaffUser } = await import('../src/models/StaffUser.model.js');
const cache = path.resolve(import.meta.dirname, '../node_modules/.cache/mongodb-memory-server');
const binaryName = fs.existsSync(cache) ? fs.readdirSync(cache).find(name => name.startsWith(`mongod-${process.arch}-${process.platform}-`)) : null;
const mongo = await MongoMemoryServer.create(binaryName ? { binary: { systemBinary: path.join(cache, binaryName) } } : {});
await mongoose.connect(mongo.getUri());
await Promise.all([StaffUser.init(), MagazineForm.init()]);
const payment = { tillNumber: 'TEST', accountName: 'Isolated test only', instructions: 'Do not pay this test order.' };
await MagazineForm.create({ title: 'Upload Performance Test', titleSw: 'Jaribio la picha', slug: 'upload-performance-test', isActive: true, price: 50000, currency: 'TZS',
  coverImageUrl: '/brand/magazine-cover-sample.jpg', sections: [{ sectionId: 'photos', title: 'Your photographs', titleSw: 'Picha zako', order: 0 }],
  fields: ['first', 'second'].map((fieldId, order) => ({ fieldId, sectionId: 'photos', type: 'photo_group', label: `${fieldId} photos`, labelSw: `Picha ${order + 1}`, order, validationRules: { maxPhotos: 100 } })), lipaNambaInstructions: payment });
const types = ['text','textarea','photo_upload','photo_group','dropdown','radio','checkbox','date','datetime','time','duration','number','linear_scale','rating','grid_radio','grid_checkbox'];
await MagazineForm.create({ title: 'Acceptance magazine', titleSw: 'Jarida la majaribio', slug: 'acceptance-magazine', isActive: true, price: 50000, currency: 'TZS',
  sections: [{sectionId:'story',title:'Your story',titleSw:'Hadithi yako',order:0}],
  fields: types.map((type, order) => ({fieldId:type,sectionId:'story',type,label:`Test ${type}`,labelSw:`Jaribio ${type}`,order,options:['One','Two'],optionsSw:['Moja','Mbili'],rows:['First','Second'],rowsSw:['Kwanza','Pili']})), lipaNambaInstructions: payment });
const passwordHash = await bcrypt.hash('Browser!2026', 10);
for (const role of ['admin','manager','designer']) await StaffUser.create({name:`Fictional ${role}`,email:`${role}@example.test`,phone:'0712000001',role,preferredLanguage:'en',passwordHash,maxActiveWorkload:20});
await StaffUser.create({name:'Fictional onboarding',email:'onboarding@example.test',role:'designer',preferredLanguage:'en',passwordHash,mustChangePassword:true,temporaryPasswordExpiresAt:new Date(Date.now()+86400000)});
// Consume the real protected-proof queue against this disposable database as a dedicated worker.
const {runProofJobs}=await import('../src/services/proofWorkerService.js');
let proofRun=null;
const worker=setInterval(()=>{if(!proofRun)proofRun=runProofJobs({maxJobs:6,budgetMs:10000}).catch(error=>console.error(error.code||error.name)).finally(()=>{proofRun=null;});},250);
const server = app.listen(5077, '127.0.0.1');
async function stop() { clearInterval(worker);if(proofRun)await proofRun;server.closeAllConnections(); await new Promise(r => server.close(r)); await mongoose.disconnect(); await mongo.stop(); fs.rmSync(sandbox,{recursive:true,force:true}); process.exit(0); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
