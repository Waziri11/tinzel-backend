import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPublicLoadData,
  normalizeGoogleFormData,
  importGoogleForm,
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

test('Google Forms importer follows an approved short-link redirect', async () => {
  const html = `<script>FB_PUBLIC_LOAD_DATA_ = ${JSON.stringify(fixture)};</script>`;
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'https://docs.google.com/forms/d/e/example/viewform' } });
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const imported = await importGoogleForm('https://forms.gle/example', { fetchImpl });
  assert.equal(imported.title, 'Wedding Magazine Form');
  assert.equal(calls.length, 2);
  assert.equal(imported.sourceUrl, 'https://docs.google.com/forms/d/e/example/viewform');
});

test('Google Forms importer rejects redirects away from Google', async () => {
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'https://example.com/private' } });
  await assert.rejects(() => importGoogleForm('https://forms.gle/example', { fetchImpl }), /Only HTTPS forms.gle/);
});

test('Google Forms importer rejects oversized pages before parsing', async () => {
  const fetchImpl = async () => new Response('x', { status: 200, headers: { 'content-type': 'text/html', 'content-length': String(6 * 1024 * 1024) } });
  await assert.rejects(() => importGoogleForm('https://forms.gle/example', { fetchImpl }), /too large/);
});

test('Google Forms importer maps grids, dates, ratings and image uploads while warning on unsupported content', () => {
  const richFixture = [null, ['', [
    [1, 'Grid', null, 7, [[11, [['Yes'], ['No']], 1, 'First row'], [12, [['Yes'], ['No']], 1, 'Second row']]],
    [2, 'Event date', null, 9, [[21, null, 1]]],
    [3, 'Rating', null, 18, [[31, 7, 0]]],
    [4, 'Images', null, 13, [[41, ['image'], 0]]],
    [5, 'Documents', null, 13, [[51, ['pdf'], 0]]],
    [6, 'Read this', null, 6],
    [7, 'Picture', null, 11],
    [8, 'Unknown', null, 99],
  ]], null, 'Rich form'];
  const imported = normalizeGoogleFormData(richFixture);
  assert.deepEqual(imported.fields.map((field) => field.type), ['grid_radio', 'date', 'rating', 'photo_group']);
  assert.deepEqual(imported.fields[0].rows, ['First row', 'Second row']);
  assert.equal(imported.fields[2].ratingConfig.levelCount, 7);
  assert.ok(imported.warnings.some((warning) => warning.includes('non-image file upload')));
  assert.ok(imported.warnings.some((warning) => warning.includes('informational text block')));
  assert.ok(imported.warnings.some((warning) => warning.includes('image')));
  assert.ok(imported.warnings.some((warning) => warning.includes('unsupported')));
});

test('Google Forms importer reports simplified branching, quiz and email collection', () => {
  const advanced = [null, ['quiz collectEmail', [
    [1, 'Choose a route', null, 2, [[1, [['Continue', null, 123]], 1]]],
  ]], null, 'Advanced'];
  const imported = normalizeGoogleFormData(advanced);
  assert.ok(imported.warnings.some((warning) => warning.includes('section branching')));
  assert.ok(imported.warnings.some((warning) => warning.includes('Quiz grading')));
  assert.ok(imported.warnings.some((warning) => warning.includes('email collection')));
});
