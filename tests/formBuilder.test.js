import { test } from 'node:test';
import assert from 'node:assert/strict';

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
