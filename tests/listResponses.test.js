import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeListAnswers, validateFormAnswers } from '../src/services/formResponseService.js';
import { MagazineForm } from '../src/models/MagazineForm.model.js';
import { Order } from '../src/models/Order.model.js';

const field = { fieldId: 'wishes', label: 'Your wishes', type: 'list', required: true };

test('list questions accept written items and reject missing or malformed answers', () => {
  for (const value of [undefined, null, [], ['', '   ', '\n']]) {
    assert.deepEqual(validateFormAnswers([field], { wishes: value }), ['Your wishes is required']);
  }
  for (const value of ['One item', [1], [{}], [['nested']], [null]]) {
    assert.deepEqual(validateFormAnswers([field], { wishes: value }), ['Your wishes must be a list of text items']);
  }
  assert.deepEqual(validateFormAnswers([field], { wishes: ['A wish', '', 'Another wish'] }), []);
  assert.deepEqual(validateFormAnswers([{ ...field, required: false }], {}), []);
  assert.deepEqual(validateFormAnswers([{ ...field, required: false }], { wishes: ['', ' '] }), []);
});

test('normalization removes empty list rows without changing order, duplicates, or other answer types', () => {
  const answers = { wishes: [' First ', '', 'Second\nline', ' First ', '  '], choices: ['A', 'B'], story: ' original text ' };
  assert.deepEqual(normalizeListAnswers([field], answers), { wishes: ['First', 'Second\nline', 'First'], choices: ['A', 'B'], story: ' original text ' });
  assert.equal(answers.wishes.length, 5);
});

test('form schema accepts lists and order snapshots preserve the response type', () => {
  const form = new MagazineForm({ title: 'Lists', slug: 'lists', price: 50000, fields: [field] });
  assert.equal(form.validateSync(), undefined);
  const order = new Order({ submissionId: 'LIST-TEST', formId: form._id, clientName: 'List test', clientWhatsApp: '+255700000001', submittedFields: [field], submittedData: { wishes: ['First', 'Second'] } });
  assert.equal(order.validateSync(), undefined);
  assert.equal(order.submittedFields[0].type, 'list');
  assert.equal(order.submittedFields[0].fieldId, 'wishes');
  assert.deepEqual(order.submittedData.wishes, ['First', 'Second']);
});
