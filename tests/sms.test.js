import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTanzanianPhone, sendNextSMS } from '../src/services/smsService.js';
import { sendSmsNotification } from '../src/controllers/smsController.js';

test('formatTanzanianPhone: removes "+" and ensures Tanzanian 255 prefix', () => {
  assert.equal(formatTanzanianPhone('+255712345678'), '255712345678');
  assert.equal(formatTanzanianPhone('255712345678'), '255712345678');
  assert.equal(formatTanzanianPhone('0712345678'), '255712345678');
  assert.equal(formatTanzanianPhone('712345678'), '255712345678');
  assert.equal(formatTanzanianPhone('+255 712-345-678'), '255712345678');
});

test('formatTanzanianPhone: throws 400 for empty or invalid phone numbers', () => {
  assert.throws(() => formatTanzanianPhone(''), { status: 400 });
  assert.throws(() => formatTanzanianPhone('12345'), { status: 400 });
  assert.throws(() => formatTanzanianPhone('+15551234567'), { status: 400 });
});

test('sendNextSMS: uses v1 Basic Auth when only NEXTSMS_USERNAME and NEXTSMS_PASSWORD are set', async () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.NEXTSMS_API_KEY;
  const originalUser = process.env.NEXTSMS_USERNAME;
  const originalPass = process.env.NEXTSMS_PASSWORD;

  delete process.env.NEXTSMS_API_KEY;
  process.env.NEXTSMS_USERNAME = 'tinzel_user';
  process.env.NEXTSMS_PASSWORD = 'secret_password';
  process.env.NEXTSMS_SENDER_ID = 'ORDER';

  let capturedUrl = null;
  let capturedOptions = null;

  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          messages: [
            {
              to: '255712345678',
              status: { groupId: 18, groupName: 'PENDING', id: 51, name: 'ENROUTE (SENT)' },
              smsCount: 1,
            },
          ],
        }),
    };
  };

  try {
    const result = await sendNextSMS('+255712345678', 'Order #TNZ-101 is Ready.');

    assert.equal(capturedUrl, 'https://messaging-service.co.tz/api/sms/v1/text/single');
    assert.equal(capturedOptions.method, 'POST');

    const expectedAuth = `Basic ${Buffer.from('tinzel_user:secret_password').toString('base64')}`;
    assert.equal(capturedOptions.headers.Authorization, expectedAuth);
    assert.equal(capturedOptions.headers['Content-Type'], 'application/json');

    const parsedBody = JSON.parse(capturedOptions.body);
    assert.deepEqual(parsedBody, {
      from: 'ORDER',
      to: '255712345678',
      text: 'Order #TNZ-101 is Ready.',
    });

    assert.equal(result.messages[0].to, '255712345678');
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.NEXTSMS_API_KEY;
    else process.env.NEXTSMS_API_KEY = originalApiKey;
    if (originalUser === undefined) delete process.env.NEXTSMS_USERNAME;
    else process.env.NEXTSMS_USERNAME = originalUser;
    if (originalPass === undefined) delete process.env.NEXTSMS_PASSWORD;
    else process.env.NEXTSMS_PASSWORD = originalPass;
  }
});

test('sendNextSMS: uses v2 Bearer token endpoint when NEXTSMS_API_KEY is set', async () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.NEXTSMS_API_KEY;

  process.env.NEXTSMS_API_KEY = '48562cb88e7b630991a2256404b37cda';

  let capturedUrl = null;
  let capturedAuthHeader = null;
  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedAuthHeader = options.headers.Authorization;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ messages: [{ to: '255762022730' }] }),
    };
  };

  try {
    await sendNextSMS('+255762022730', 'Order Ready');
    assert.equal(capturedUrl, 'https://messaging-service.co.tz/api/sms/v2/text/single');
    assert.equal(capturedAuthHeader, 'Bearer 48562cb88e7b630991a2256404b37cda');
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.NEXTSMS_API_KEY;
    else process.env.NEXTSMS_API_KEY = originalApiKey;
  }
});

test('sendNextSMS: throws error when NextSMS response is not OK', async () => {
  const originalFetch = global.fetch;
  const originalUser = process.env.NEXTSMS_USERNAME;
  const originalPass = process.env.NEXTSMS_PASSWORD;

  process.env.NEXTSMS_USERNAME = 'tinzel_user';
  process.env.NEXTSMS_PASSWORD = 'wrong_password';

  global.fetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    text: async () => JSON.stringify({ message: 'Invalid credentials' }),
  });

  try {
    await assert.rejects(
      () => sendNextSMS('0712345678', 'Order Ready'),
      (err) => {
        assert.equal(err.status, 401);
        assert.match(err.message, /Invalid credentials/);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
    if (originalUser === undefined) delete process.env.NEXTSMS_USERNAME;
    else process.env.NEXTSMS_USERNAME = originalUser;
    if (originalPass === undefined) delete process.env.NEXTSMS_PASSWORD;
    else process.env.NEXTSMS_PASSWORD = originalPass;
  }
});

test('sendSmsNotification controller: validates request body and returns 200 on success', async () => {
  const originalFetch = global.fetch;
  const originalUser = process.env.NEXTSMS_USERNAME;
  const originalPass = process.env.NEXTSMS_PASSWORD;

  process.env.NEXTSMS_USERNAME = 'tinzel_user';
  process.env.NEXTSMS_PASSWORD = 'secret_password';

  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ messages: [{ to: '255755112233' }] }),
  });

  const createMockRes = () => {
    const res = {
      statusCode: 200,
      payload: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        this.payload = data;
        return this;
      },
    };
    return res;
  };

  try {
    // 1. Missing "to" returns 400
    const resMissingTo = createMockRes();
    await sendSmsNotification({ body: { message: 'Order Ready' } }, resMissingTo, () => {});
    assert.equal(resMissingTo.statusCode, 400);
    assert.equal(resMissingTo.payload.success, false);

    // 2. Missing "message" returns 400
    const resMissingMsg = createMockRes();
    await sendSmsNotification({ body: { to: '0755112233' } }, resMissingMsg, () => {});
    assert.equal(resMissingMsg.statusCode, 400);
    assert.equal(resMissingMsg.payload.success, false);

    // 3. Valid request returns 200
    const resOk = createMockRes();
    await sendSmsNotification(
      { body: { to: '0755112233', message: 'Your order is Ready!' } },
      resOk,
      () => {}
    );
    assert.equal(resOk.statusCode, 200);
    assert.equal(resOk.payload.success, true);
    assert.equal(resOk.payload.data.messages[0].to, '255755112233');
  } finally {
    global.fetch = originalFetch;
    if (originalUser === undefined) delete process.env.NEXTSMS_USERNAME;
    else process.env.NEXTSMS_USERNAME = originalUser;
    if (originalPass === undefined) delete process.env.NEXTSMS_PASSWORD;
    else process.env.NEXTSMS_PASSWORD = originalPass;
  }
});
