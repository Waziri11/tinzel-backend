import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFormForPublication } from '../src/services/formPublicationService.js';
import { validateFormAnswers } from '../src/services/formResponseService.js';

test('Form Builder: draft publication requires complete Tinzel settings', () => {
  const incomplete = validateFormForPublication({ title: 'Imported form', sections: [], fields: [] });
  assert.ok(incomplete.includes('A magazine cover image is required'));
  assert.ok(incomplete.includes('At least one question is required'));

  const complete = validateFormForPublication({
    title: 'Imported form',
    coverImageUrl: '/uploads/covers/cover.jpg',
    price: 75000,
    currency: 'TZS',
    sections: [{ sectionId: 'section_1', title: 'Questions' }],
    fields: [{ fieldId: 'field_1', label: 'Name' }],
    lipaNambaInstructions: { tillNumber: '123', accountName: 'Tinzel', instructions: 'Pay here' },
  });
  assert.deepEqual(complete, []);
});

test('Form Builder: Validates required dynamic fields in submission', () => {
  const formSchema = {
    title: 'Harusi Yetu - Wedding Edition',
    fields: [
      { fieldId: 'couple_names', label: 'Couple Names', required: true, type: 'text' },
      { fieldId: 'event_date', label: 'Wedding Date', required: true, type: 'date' },
      { fieldId: 'story', label: 'Love Story', required: false, type: 'textarea' },
    ],
  };

  const validateSubmission = (schema, answers) => {
    const missing = [];
    for (const field of schema.fields) {
      if (field.required && (!answers[field.fieldId] || String(answers[field.fieldId]).trim() === '')) {
        missing.push(field.fieldId);
      }
    }
    return missing;
  };

  const validAnswers = {
    couple_names: 'Emmanuel & Neema',
    event_date: '2026-12-20',
  };
  assert.deepEqual(validateSubmission(formSchema, validAnswers), []);

  const invalidAnswers = {
    story: 'We met in college...',
  };
  assert.deepEqual(validateSubmission(formSchema, invalidAnswers), ['couple_names', 'event_date']);
});

test('Form Builder: Enforces photo upload min and max constraints', () => {
  const photoField = {
    fieldId: 'photos',
    label: 'Photos',
    type: 'photo_upload',
    validationRules: { minPhotos: 5, maxPhotos: 20 },
  };

  const checkPhotoCount = (field, count) => {
    if (count < field.validationRules.minPhotos) return 'BELOW_MIN';
    if (count > field.validationRules.maxPhotos) return 'EXCEEDS_MAX';
    return 'VALID';
  };

  assert.equal(checkPhotoCount(photoField, 2), 'BELOW_MIN');
  assert.equal(checkPhotoCount(photoField, 8), 'VALID');
  assert.equal(checkPhotoCount(photoField, 25), 'EXCEEDS_MAX');
});

test('Form Builder: validates structured checkbox and grid answers', () => {
  const fields = [
    { fieldId: 'choices', label: 'Choices', type: 'checkbox', required: true },
    { fieldId: 'grid', label: 'Grid', type: 'grid_radio', rows: ['A', 'B'], required: true },
  ];
  assert.deepEqual(validateFormAnswers(fields, { choices: ['One'], grid: { A: 'Yes', B: 'No' } }), []);
  assert.deepEqual(validateFormAnswers(fields, { choices: [], grid: { A: 'Yes' } }), ['Choices is required', 'Grid is required']);
});
