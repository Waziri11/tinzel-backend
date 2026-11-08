import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
process.env.NODE_ENV = 'test';
process.env.DOTENV_CONFIG_PATH = '/private/tmp/tinzel-google-import-test-absent.env';
process.env.SECURITY_OTP_SINK = 'true';
process.env.JWT_SECRET = 'google-import-isolated-test-key';
const { default: app } = await import('../src/app.js');
const { StaffUser } = await import('../src/models/StaffUser.model.js');
const { MagazineForm } = await import('../src/models/MagazineForm.model.js');
const { AuditLog } = await import('../src/models/AuditLog.model.js');
const { AccessSession } = await import('../src/models/AccessSession.model.js');
const { createSession, digest } = await import('../src/services/accessSessionService.js');
let db, server, base;
const auth = {};
const formData = [null, ['Saved form description', [
  [1, 'Name', null, 0, [[11, null, 1]]],
  [2, 'Anniversary', null, 9, [[22, null, 1, null, null, null, null, [0, 1]]]],
  [3, 'Photos', null, 13, [[33, null, 0]]],
]], null, 'Saved Google form'];
before(async () => {
  db = await MongoMemoryServer.create(); await mongoose.connect(db.getUri());
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const role of ['admin', 'manager', 'designer']) {
    const user = await StaffUser.create({ name: role, email: `${role}@example.test`, passwordHash: 'unused', role });
    const token = await createSession('staff', user, { verifiedAt: new Date() });
    auth[role] = { Cookie: `tinzel_staff=${token}`, 'X-CSRF-Token': (await AccessSession.findById(digest(token))).csrf };
  }
});
after(async () => { server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await db?.stop(); });
async function post(body, headers = {}) {
  const response = await fetch(base + '/api/admin/forms/import-google', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5177', ...headers }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
test('admin and manager import saved questions as persisted, unpublished drafts with warnings', async () => {
  for (const role of ['admin', 'manager']) {
    const result = await post({ formData, url: 'https://forms.gle/example' }, auth[role]);
    assert.equal(result.status, 201, JSON.stringify(result.data));
    const saved = await MagazineForm.findById(result.data.form._id).lean();
    assert.equal(saved.isActive, false);
    assert.deepEqual(saved.fields.map(field => field.type), ['text', 'date', 'photo_group']);
    assert.equal(saved.importSource.sourceUrl, 'https://forms.gle/example');
    assert.equal(saved.importSource.warnings.length, 1);
    assert.ok(await AuditLog.exists({ action: 'FORM_IMPORTED', 'details.formId': saved._id }));
    const publicResponse = await fetch(base + '/api/public/forms/' + saved.slug);
    assert.equal(publicResponse.status, 404);
  }
});
test('saved-form import enforces staff roles and CSRF before creating data', async () => {
  const count = await MagazineForm.countDocuments();
  assert.equal((await post({ formData })).status, 401);
  assert.equal((await post({ formData }, auth.designer)).status, 403);
  assert.equal((await post({ formData }, { Cookie: auth.admin.Cookie })).status, 403);
  assert.equal(await MagazineForm.countDocuments(), count);
});
test('invalid saved data and source links are rejected without creating a draft', async () => {
  const count = await MagazineForm.countDocuments();
  for (const body of [{ formData: null }, { formData: [1] }, { formData, url: 'https://example.com/' }]) {
    const result = await post(body, auth.admin);
    assert.equal(result.status, 400);
    assert.match(result.data.errorCode, /^GOOGLE_FORM_/);
  }
  assert.equal(await MagazineForm.countDocuments(), count);
});
