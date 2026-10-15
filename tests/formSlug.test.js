import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableFormSlug, slugFromTitle } from '../src/utils/formSlug.js';

test('edition addresses are derived from titles', () => {
  assert.equal(slugFromTitle('  Graduation Keepsake Magazine!  '), 'graduation-keepsake-magazine');
  assert.equal(slugFromTitle('Édition Spéciale'), 'edition-speciale');
  assert.equal(slugFromTitle(''), 'edition');
});

test('an existing address gets the next available number', async () => {
  const existing = new Set(['graduation-magazine', 'graduation-magazine-2']);
  assert.equal(
    await availableFormSlug('Graduation Magazine', (slug) => existing.has(slug)),
    'graduation-magazine-3'
  );
});
