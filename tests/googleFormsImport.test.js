import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPublicLoadData,
  normalizeGoogleFormData,
  validateGoogleFormUrl,
  GoogleFormsImportError,
} from '../src/services/googleFormsImportService.js';

const fixture = [null, [
  'Tell us about your event',
  [
    [100, 'Your name', 'As shown on the cover', 0, [[1000, null, 1]]],
    [101, 'Choose a style', null, 2, [[1001, [['Classic'], ['Modern']], 1]]],
    [102, 'Highlights', null, 4, [[1002, [['Ceremony'], ['Reception']], 0]]],
    [200, 'Photos and ratings', 'Second section', 8],
    [103, 'Rate the concept', null, 5, [[1003, [[1], [5]], 1, 'Low', 'High']]],
    [104, 'When should we call?', null, 10, [[1004, null, 0]]],
    [105, 'Intro video', null, 12],
  ],
], null, 'Wedding Magazine Form'];

test('Google Forms importer extracts bootstrap data and maps supported questions', () => {
  const html = `<html><script>var FB_PUBLIC_LOAD_DATA_ = ${JSON.stringify(fixture)};</script></html>`;
  assert.deepEqual(extractPublicLoadData(html), fixture);
  const imported = normalizeGoogleFormData(fixture, 'https://docs.google.com/forms/d/e/example/viewform');
  assert.equal(imported.title, 'Wedding Magazine Form');
  assert.equal(imported.sections.length, 2);
  assert.deepEqual(imported.fields.map((field) => field.type), ['text', 'radio', 'checkbox', 'linear_scale', 'time']);
  assert.deepEqual(imported.fields[1].options, ['Classic', 'Modern']);
  assert.ok(imported.warnings.some((warning) => warning.includes('video')));
});

test('Google Forms importer only accepts approved HTTPS hosts', () => {
  assert.equal(validateGoogleFormUrl('https://forms.gle/abc').hostname, 'forms.gle');
  assert.equal(validateGoogleFormUrl('https://docs.google.com/forms/d/e/abc/viewform').hostname, 'docs.google.com');
  assert.throws(() => validateGoogleFormUrl('http://forms.gle/abc'), GoogleFormsImportError);
  assert.throws(() => validateGoogleFormUrl('https://example.com/forms.gle/abc'), GoogleFormsImportError);
  assert.throws(() => validateGoogleFormUrl('https://docs.google.com/document/d/abc'), GoogleFormsImportError);
});

test('Google Forms importer rejects pages without public form data', () => {
  assert.throws(() => extractPublicLoadData('<html>Sign in</html>'), /restricted, unpublished/);
});
