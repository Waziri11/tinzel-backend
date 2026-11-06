import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { randomBytes } from 'node:crypto';
import app from '../src/app.js';
import { StaffUser } from '../src/models/StaffUser.model.js';
import { generateToken } from '../src/middlewares/auth.middleware.js';
let mongo,
  server,
  base,
  users = {},
  tokens = {};
before(async () => {
  process.env.STAFF_CREDENTIAL_ENCRYPTION_KEY =
    randomBytes(32).toString('base64');
  for (const key of [
    'SMTP_USER',
    'SMTP_PASS',
    'NEXTSMS_API_KEY',
    'NEXTSMS_USERNAME',
    'NEXTSMS_PASSWORD',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_PHONE_NUMBER',
  ])
    delete process.env[key];
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  for (const role of ['admin', 'manager', 'designer']) {
    users[role] = await StaffUser.create({
      name: role,
      email: `${role}@workspace.test`,
      role,
      passwordHash: 'unused',
      phone: '0712000011',
    });
    tokens[role] = await generateToken(users[role],{verifiedAt:new Date()});
  }
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mongo.stop();
});
async function req(path, role = 'manager', method = 'GET', body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${tokens[role]}`,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json() };
}
test('manager can manage magazine forms through the same endpoints as admin', async () => {
  const forms = '/admin/forms';
  const draft = {
    title: 'Manager edition',
    coverImageUrl: '/cover.jpg',
    sections: [{ sectionId: 'story', title: 'Story' }],
    fields: [{ sectionId: 'story', fieldId: 'headline', type: 'text', label: 'Headline' }],
    lipaNambaInstructions: { tillNumber: 'TEST', accountName: 'Test', instructions: 'Test only' },
  };
  const created = await req(forms, 'manager', 'POST', draft);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.form._id;
  const path = `${forms}/${id}`;
  for (const role of ['admin', 'manager']) {
    const list = await req(forms, role);
    assert.equal(list.status, 200);
    assert.ok(list.data.forms.some(form => form._id === id));
  }
  assert.equal((await req(forms, 'designer')).status, 403);
  assert.equal((await req(path, 'designer', 'DELETE')).status, 403);
  assert.equal((await req(path, 'manager', 'PUT', { ...draft, title: 'Updated edition' })).status, 200);
  const published = await req(`${path}/publish`, 'manager', 'POST', {});
  assert.equal(published.status, 200, JSON.stringify(published.data));
  assert.equal(published.data.form.isActive, true);
  const archived = await req(path, 'manager', 'DELETE');
  assert.equal(archived.status, 200);
  assert.equal(archived.data.form.isArchived, true);
});

test('manager lists designers only and cannot target privileged users or delete', async () => {
  const r = await req('/manager/staff');
  assert.equal(r.status, 200);
  assert.ok(r.data.staff.length);
  assert.ok(
    r.data.staff.every((x) => x.role === 'designer' && !x.passwordHash),
  );
  for (const role of ['admin', 'manager'])
    for (const [method, suffix, body] of [
      ['GET', '', undefined],
      ['PUT', '', { name: 'Changed' }],
      ['POST', '/initial-password', {}],
      ['POST', '/credential-delivery/retry', { channel: 'sms' }],
    ])
      assert.equal(
        (
          await req(
            `/manager/staff/${users[role]._id}${suffix}`,
            'manager',
            method,
            body,
          )
        ).status,
        404,
      );
  assert.equal(
    (await req(`/manager/staff/${users.designer._id}`, 'manager', 'DELETE'))
      .status,
    403,
  );
  assert.equal(
    (
      await req(`/manager/staff/${users.designer._id}`, 'manager', 'PUT', {
        role: 'admin',
      })
    ).status,
    403,
  );
  assert.equal((await req('/admin/staff')).status, 403);
  assert.equal((await req('/manager/staff', 'designer')).status, 403);
});
test('manager creates designer through onboarding and can edit capacity', async () => {
  const r = await req('/manager/staff', 'manager', 'POST', {
    name: 'New designer',
    email: 'new@workspace.test',
    role: 'designer',
    phone: '0712000012',
    maxActiveWorkload: 3,
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.user.mustChangePassword, true);
  assert.ok(!r.data.user.passwordHash && !r.data.user.credentialJob);
  assert.equal(
    (
      await req('/manager/staff', 'manager', 'POST', {
        name: 'Wrong',
        email: 'wrong@workspace.test',
        role: 'manager',
        phone: '0712000012',
      })
    ).status,
    403,
  );
  const edit = await req(
    `/manager/staff/${users.designer._id}`,
    'manager',
    'PUT',
    { maxActiveWorkload: 9 },
  );
  assert.equal(edit.status, 200);
  assert.equal(edit.data.user.maxActiveWorkload, 9);
});
test('profile updates cannot alter email or role', async () => {
  const r = await req('/staff/profile', 'manager', 'PATCH', {
    name: 'Manager Updated',
    phone: '0712000011',
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.name, 'Manager Updated');
  assert.equal(
    (
      await req('/staff/profile', 'manager', 'PATCH', {
        name: 'x',
        phone: '0712000011',
        role: 'admin',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await req('/staff/profile', 'manager', 'PATCH', {
        name: 'x',
        phone: 'bad',
      })
    ).status,
    400,
  );
  assert.equal((await req('/staff/me')).data.user.phone, '0712000011');
});
test('system summaries are restricted, available independently and never invent quotas', async () => {
  for (const section of ['runtime', 'storage', 'messaging']) {
    assert.equal(
      (await req(`/system/summary/${section}`, 'designer')).status,
      403,
    );
    const r = await req(`/system/summary/${section}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.measuredAt);
    assert.ok(!JSON.stringify(r.data).includes('password'));
    if (section === 'runtime') {
      assert.ok(r.data.processMemoryBytes > 0);
      assert.equal(r.data.hostingRamAvailableBytes, null);
    }
    if (section === 'storage') assert.equal(r.data.quotaBytes, null);
  }
});

test('assigned designers cannot be deactivated and inactive designers lose access', async () => {
  const { Order } = await import('../src/models/Order.model.js');
  const { MagazineForm } = await import('../src/models/MagazineForm.model.js');
  const form = await MagazineForm.create({
    title: 'Access guard',
    slug: 'access-guard',
    price: 1,
  });
  const order = await Order.create({
    submissionId: 'SUB-WORKSPACE-GUARD',
    formId: form._id,
    clientName: 'Test',
    clientWhatsApp: '0712000011',
    assignedDesigner: users.designer._id,
    status: 'assigned',
  });
  assert.equal(
    (
      await req(`/manager/staff/${users.designer._id}`, 'manager', 'PUT', {
        isActive: false,
      })
    ).status,
    409,
  );
  await Order.deleteOne({ _id: order._id });
  assert.equal(
    (
      await req(`/manager/staff/${users.designer._id}`, 'manager', 'PUT', {
        isActive: false,
      })
    ).status,
    200,
  );
  assert.equal((await req('/staff/me', 'designer')).status, 401);
});

test('provider secrets are encrypted, never returned or audited, and overrides can be removed', async () => {
  const { ProviderConfig } = await import(
    '../src/models/ProviderConfig.model.js'
  );
  const { AuditLog } = await import('../src/models/AuditLog.model.js');
  const {
    refreshProviderSettings,
    providerValue,
    encryptProviderSecret,
    decryptProviderSecret,
  } = await import('../src/services/providerConfigService.js');
  process.env.PROVIDER_CONFIG_ENCRYPTION_KEY =
    randomBytes(32).toString('base64');
  process.env.NEXTSMS_API_KEY = 'env-fallback-token';
  const secret = 'saved-secret-that-must-not-leak';
  const encoded = encryptProviderSecret(secret, 'NEXTSMS_API_KEY');
  assert.equal(decryptProviderSecret(encoded, 'NEXTSMS_API_KEY'), secret);
  assert.throws(() => decryptProviderSecret(encoded, 'SMTP_PASS'));
  assert.equal((await req('/admin/providers')).status, 403);
  assert.equal((await req('/admin/providers', 'designer')).status, 401);
  const save = await req('/admin/providers/nextsms', 'admin', 'PUT', {
    revision: null,
    values: { NEXTSMS_API_KEY: secret, NEXTSMS_SENDER_ID: 'TINZEL' },
    remove: [],
  });
  assert.equal(save.status, 200, JSON.stringify(save.data));
  assert.ok(!JSON.stringify(save.data).includes(secret));
  const row = await ProviderConfig.findOne({ provider: 'nextsms' })
    .select('+secrets')
    .lean();
  assert.ok(!JSON.stringify(row).includes(secret));
  assert.equal(
    decryptProviderSecret(row.secrets.NEXTSMS_API_KEY, 'NEXTSMS_API_KEY'),
    secret,
  );
  assert.ok(
    !JSON.stringify(
      await AuditLog.find({ action: 'PROVIDER_CONFIG_UPDATED' }).lean(),
    ).includes(secret),
  );
  await refreshProviderSettings(true);
  assert.equal(providerValue('NEXTSMS_API_KEY'), secret);
  let metadata = save.data.providers.find((x) => x.provider === 'nextsms');
  assert.equal(
    metadata.fields.find((x) => x.name === 'NEXTSMS_API_KEY').source,
    'saved',
  );
  assert.equal(
    metadata.fields.find((x) => x.name === 'NEXTSMS_API_KEY').value,
    undefined,
  );
  const keep = await req('/admin/providers/nextsms', 'admin', 'PUT', {
    revision: metadata.revision,
    values: { NEXTSMS_API_KEY: '' },
    remove: [],
  });
  assert.equal(keep.status, 200);
  await refreshProviderSettings(true);
  assert.equal(providerValue('NEXTSMS_API_KEY'), secret);
  assert.equal(
    (
      await req('/admin/providers/nextsms', 'admin', 'PUT', {
        revision: null,
        values: { NEXTSMS_API_KEY: 'x' },
        remove: [],
      })
    ).status,
    409,
  );
  metadata = keep.data.providers.find((x) => x.provider === 'nextsms');
  const remove = await req('/admin/providers/nextsms', 'admin', 'PUT', {
    revision: metadata.revision,
    values: {},
    remove: ['NEXTSMS_API_KEY'],
  });
  assert.equal(remove.status, 200);
  await refreshProviderSettings(true);
  assert.equal(providerValue('NEXTSMS_API_KEY'), 'env-fallback-token');
  delete process.env.NEXTSMS_API_KEY;
});

test('provider settings fail closed without encryption and reject invalid field types', async () => {
  const savedKey = process.env.PROVIDER_CONFIG_ENCRYPTION_KEY;
  delete process.env.PROVIDER_CONFIG_ENCRYPTION_KEY;
  assert.equal(
    (
      await req('/admin/providers/smtp', 'admin', 'PUT', {
        revision: null,
        values: { SMTP_PASS: 'secret' },
        remove: [],
      })
    ).status,
    503,
  );
  process.env.PROVIDER_CONFIG_ENCRYPTION_KEY = savedKey;
  for (const values of [
    { SMTP_PORT: '70000' },
    { SMTP_SECURE: 'maybe' },
    { SMTP_PASS: { value: 'injection' } },
    { UNKNOWN_KEY: 'x' },
  ])
    assert.equal(
      (
        await req('/admin/providers/smtp', 'admin', 'PUT', {
          revision: null,
          values,
          remove: [],
        })
      ).status,
      400,
    );
  const { invalidateProviderSettings, refreshProviderSettings } = await import(
    '../src/services/providerConfigService.js'
  );
  const r = await req('/admin/providers/smtp', 'admin', 'PUT', {
    revision: null,
    values: { SMTP_PASS: 'encrypted' },
    remove: [],
  });
  assert.equal(r.status, 200);
  process.env.PROVIDER_CONFIG_ENCRYPTION_KEY =
    randomBytes(32).toString('base64');
  invalidateProviderSettings();
  await assert.rejects(() => refreshProviderSettings(true));
  process.env.PROVIDER_CONFIG_ENCRYPTION_KEY = savedKey;
  invalidateProviderSettings();
  await refreshProviderSettings(true);
});

test('manager cannot change settings, test providers or read detailed diagnostics', async () => {
  for (const [path, method] of [
    ['/admin/providers/smtp/check', 'POST'],
    ['/admin/providers/smtp', 'PUT'],
    ['/notifications/settings', 'PUT'],
    ['/notifications/settings/reset', 'POST'],
    ['/notifications/diagnostics', 'GET'],
    ['/notifications/health-test/sms', 'POST'],
    ['/notifications/health-test/email', 'POST'],
    ['/notifications/test-send', 'POST'],
  ])
    assert.equal(
      (await req(path, 'manager', method, method === 'GET' ? undefined : {}))
        .status,
      403,
      path,
    );
});

test('saved providers drive SMS requests, SMTP client renewal and Twilio webhook verification', async () => {
  const { ProviderConfig } = await import(
    '../src/models/ProviderConfig.model.js'
  );
  const { refreshProviderSettings, invalidateProviderSettings } = await import(
    '../src/services/providerConfigService.js'
  );
  const { sendNextSMS } = await import('../src/services/smsService.js');
  const { getTransporter } = await import('../src/services/emailService.js');
  const { default: twilio } = await import('twilio');
  await ProviderConfig.deleteMany({});
  invalidateProviderSettings();
  assert.equal(
    (
      await req('/admin/providers/nextsms', 'admin', 'PUT', {
        revision: null,
        values: {
          NEXTSMS_AUTH_MODE: 'api_key',
          NEXTSMS_API_KEY: 'request-test-token',
          NEXTSMS_SENDER_ID: 'TEST',
        },
        remove: [],
      })
    ).status,
    200,
  );
  const originalFetch = global.fetch;
  let remoteCalls = 0;
  global.fetch = async (url, options) => {
    if (String(url).includes('messaging-service.co.tz')) {
      remoteCalls++;
      assert.equal(options.headers.Authorization, 'Bearer request-test-token');
      assert.equal(JSON.parse(options.body).from, 'TEST');
      return new Response(
        JSON.stringify({ messages: [{ status: { groupName: 'PENDING' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return originalFetch(url, options);
  };
  try {
    await sendNextSMS('0712000011', 'Synthetic test');
    assert.equal(remoteCalls, 1);
  } finally {
    global.fetch = originalFetch;
  }
  const first = await req('/admin/providers/smtp', 'admin', 'PUT', {
    revision: null,
    values: {
      SMTP_USER: 'synthetic@example.test',
      SMTP_PASS: 'test-one',
      SMTP_HOST: 'smtp.example.test',
    },
    remove: [],
  });
  assert.equal(first.status, 200);
  await refreshProviderSettings(true);
  const clientA = getTransporter();
  const rev = first.data.providers.find((x) => x.provider === 'smtp').revision;
  assert.equal(
    (
      await req('/admin/providers/smtp', 'admin', 'PUT', {
        revision: rev,
        values: { SMTP_PASS: 'test-two' },
        remove: [],
      })
    ).status,
    200,
  );
  await refreshProviderSettings(true);
  assert.ok(
    clientA !== getTransporter(),
    'SMTP transport must renew after credential change',
  );
  assert.equal(
    (
      await req('/admin/providers/twilio', 'admin', 'PUT', {
        revision: null,
        values: { TWILIO_AUTH_TOKEN: 'webhook-test-token' },
        remove: [],
      })
    ).status,
    200,
  );
  const oldEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const url = base + '/notifications/webhooks/twilio-status';
    const body = {
      MessageSid: 'SM-test-workspace',
      MessageStatus: 'delivered',
    };
    const signature = twilio.getExpectedTwilioSignature(
      'webhook-test-token',
      url,
      body,
    );
    const response = await originalFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-twilio-signature': signature,
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    const bad = await originalFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-twilio-signature': 'wrong',
      },
      body: JSON.stringify(body),
    });
    assert.equal(bad.status, 403);
  } finally {
    if (oldEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldEnvironment;
  }
  await ProviderConfig.deleteMany({});
  invalidateProviderSettings();
});

test('balance parsing and provider error redaction handle unavailable and credential-bearing payloads', async () => {
  const { extractSmsBalance } = await import(
    '../src/services/systemSummaryService.js'
  );
  assert.equal(extractSmsBalance({ default_balance: 1200 }), 1200);
  assert.equal(extractSmsBalance({ data: { balance: '42' } }), 42);
  assert.equal(extractSmsBalance({ balance: 'unknown' }), null);
  assert.equal(extractSmsBalance({ balance: -1 }), null);
  assert.equal(extractSmsBalance(null), null);
  const { redactProviderDiagnostics } = await import(
    '../src/services/providerConfigService.js'
  );
  process.env.NEXTSMS_API_KEY = 'redaction-test-value';
  const safe = redactProviderDiagnostics({
    message: 'Bearer redaction-test-value',
    password: 'do-not-return',
    nested: ['redaction-test-value'],
  });
  assert.ok(!JSON.stringify(safe).includes('redaction-test-value'));
  assert.ok(!JSON.stringify(safe).includes('do-not-return'));
  delete process.env.NEXTSMS_API_KEY;
});

test('unavailable storage measurements do not break runtime summaries', async () => {
  const { clearSystemSummaryCache } = await import(
    '../src/services/systemSummaryService.js'
  );
  clearSystemSummaryCache();
  const original = mongoose.connection.db.stats;
  mongoose.connection.db.stats = async () => {
    throw new Error('storage unavailable');
  };
  try {
    const storage = await req('/system/summary/storage');
    assert.equal(storage.status, 503);
    assert.equal(storage.data.message, 'System measurement unavailable.');
    assert.equal((await req('/system/summary/runtime')).status, 200);
  } finally {
    mongoose.connection.db.stats = original;
    clearSystemSummaryCache();
  }
});
