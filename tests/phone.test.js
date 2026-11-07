import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, requirePhone, samePhone } from '../src/utils/phone.js';

test('phones default to Tanzania, preserve explicit foreign codes, and reject ambiguous inputs', () => {
  for (const value of ['0712 345 678', '0712345678', '712345678', '255712345678', '+255 (712) 345-678', '00255.712.345.678']) assert.equal(normalizePhone(value), '+255712345678');
  for (const value of ['+254 712 345 678', '00254 (712) 345-678']) assert.equal(normalizePhone(value), '+254712345678');
  assert.equal(normalizePhone('+1 (555) 123-4567'), '+15551234567');
  assert.equal(normalizePhone('022 123 4567'), '+255221234567');
  for (const value of [null, undefined, {}, 712345678, '', 'abc', '071234567', '07123456789', '254712345678', '+2550712345678', '+25571234567', '++255712345678', '+2557+12345678', '+0123456789', '+1234567890123456', '0712345678 ext 2']) {
    assert.equal(normalizePhone(value), null, String(value));
    assert.throws(() => requirePhone(value), { status: 400 });
  }
  assert.equal(samePhone('0712 345 678', '+255712345678'), true);
  assert.equal(samePhone('+254712345678', '+255712345678'), false);
  assert.equal(samePhone('', ''), false);
});

import { phoneMatchPattern } from '../src/utils/phone.js';
import { validateProviderValue } from '../src/services/providerConfigService.js';
test('inbound matches full phone identity and provider phone settings are canonical', () => {
  const pattern = phoneMatchPattern('+255712345678');
  for (const value of ['0712 345 678', '+255 (712) 345-678', '00255712345678', '712345678']) assert.equal(pattern.test(value), true);
  for (const value of ['+254712345678', '+1255712345678', '+255712345679', 'abc0712345678']) assert.equal(pattern.test(value), false);
  assert.equal(validateProviderValue('TWILIO_PHONE_NUMBER', '0712 345 678'), '+255712345678');
  assert.equal(validateProviderValue('TWILIO_WHATSAPP_NUMBER', 'whatsapp:+15551234567'), '+15551234567');
});
