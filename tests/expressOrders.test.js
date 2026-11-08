import test from 'node:test';
import assert from 'node:assert/strict';
import { expressDeadline, standardDeadline, orderPricing } from '../src/services/expressOrderService.js';
import { workflowMessage } from '../src/services/workflowMessages.js';

test('24 hours counts every Monday–Saturday hour and excludes Sundays in Tanzania', () => {
  for (const [start, end] of [
    ['2026-11-06T10:15:00+03:00', '2026-11-07T10:15:00+03:00'],
    ['2026-11-07T10:15:00+03:00', '2026-11-09T10:15:00+03:00'],
    ['2026-11-07T00:00:00+03:00', '2026-11-08T00:00:00+03:00'],
    ['2026-11-08T00:00:00+03:00', '2026-11-10T00:00:00+03:00'],
    ['2026-11-08T23:59:00+03:00', '2026-11-10T00:00:00+03:00'],
    ['2026-11-09T00:00:00+03:00', '2026-11-10T00:00:00+03:00'],
    ['2026-11-07T23:59:59+03:00', '2026-11-09T23:59:59+03:00'],
  ]) assert.equal(expressDeadline(start).toISOString(), new Date(end).toISOString());
  assert.throws(() => expressDeadline('bad'));
});

test('server calculates express pricing and rejects invalid choices', () => {
  const form = { price: 50000, currency: 'TZS' };
  assert.deepEqual(orderPricing(form, true), { isExpress: true, basePrice: 50000, expressFee: 20000, totalPrice: 70000, currency: 'TZS' });
  assert.equal(orderPricing(form).totalPrice, 50000);
  assert.equal(orderPricing(form, 'false').expressFee, 0);
  assert.equal(orderPricing(form, 'true').expressFee, 20000);
  for (const value of [null, 1, {}, 'yes']) assert.throws(() => orderPricing(form, value), { status: 400 });
  assert.throws(() => orderPricing({ ...form, currency: 'USD' }, true), { status: 400 });
});

test('standard gets 72 counting hours, excluding Tanzania Sundays', () => {
  for (const [start, end] of [
    ['2026-11-09T10:15:00+03:00', '2026-11-12T10:15:00+03:00'],
    ['2026-11-06T10:15:00+03:00', '2026-11-10T10:15:00+03:00'],
    ['2026-11-05T00:00:00+03:00', '2026-11-08T00:00:00+03:00'],
    ['2026-11-08T23:59:00+03:00', '2026-11-12T00:00:00+03:00'],
  ]) assert.equal(standardDeadline(start).toISOString(), new Date(end).toISOString());
  assert.throws(() => standardDeadline('bad'));
});

test('every staff notification channel identifies express and its deadline in both languages', () => {
  for (const role of ['manager', 'admin', 'designer', 'printer', 'client']) for (const channel of ['sms', 'email', 'whatsapp', 'in_system']) for (const lang of ['en', 'sw']) {
    const order = { isExpress: true, clientName: 'Express fixture', expressDueAt: '2026-11-09T07:15:00Z' };
    const content = workflowMessage('order_assigned', order, {}, { role, channel }, lang, '');
    assert.match(content.title, /EXPRESS/);
    assert.match(content.message, /EXPRESS/);
    assert.match(content.message, /10:15.*EAT/);
    assert.match(content.message, lang === 'en' ? /Sundays excluded/ : /Jumapili haihesabiwi/);
    delete order.expressDueAt;
    assert.match(workflowMessage('order_submitted', order, {}, { role, channel }, lang, '').message, /20,000/);
    order.isExpress = false;
    assert.doesNotMatch(workflowMessage('order_assigned', order, {}, { role, channel }, lang, '').message, /EXPRESS/);
  }
});
