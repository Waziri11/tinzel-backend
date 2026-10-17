import { test } from 'node:test';
import assert from 'node:assert/strict';
import { photoArchiveEntries, photoArchiveFileName } from '../src/utils/photoArchive.js';

test('photo folder ZIP contains only the requested folder and preserves unique names', () => {
  const photos = [
    { folderName: 'Before photos', url: '/uploads/photos/one.jpg', originalName: 'cover.jpg' },
    { folderName: 'Before photos', url: '/uploads/photos/two.jpg', originalName: 'cover.jpg' },
    { folderName: 'After photos', url: '/uploads/photos/three.jpg', originalName: 'other.jpg' },
  ];
  const entries = photoArchiveEntries(photos, 'Before photos', '/tmp/photos');
  assert.deepEqual(entries.map((entry) => entry.archiveName), [
    'Before photos/cover.jpg',
    'Before photos/cover (2).jpg',
  ]);
  assert.equal(entries[0].diskPath, '/tmp/photos/one.jpg');
  assert.equal(photoArchiveFileName('TNZ-2026-0001', 'Before photos'), 'tnz-2026-0001-before-photos.zip');
});

test('photo folder ZIP rejects paths outside stored photos', () => {
  assert.throws(
    () => photoArchiveEntries([{ folderName: 'Before photos', url: '/uploads/photos/../../secret', originalName: 'secret' }], 'Before photos', '/tmp/photos'),
    /invalid stored path/
  );
});

test('photo folder ZIP supports GridFS photo URLs', () => {
  const photos = [
    { folderName: 'Spread 1', url: '/api/public/photos/65f1a2b3c4d5e6f7a8b9c0d1', originalName: 'portrait.jpg' },
  ];
  const entries = photoArchiveEntries(photos, 'Spread 1', '/tmp/photos');
  assert.deepEqual(entries, [
    {
      gridFsId: '65f1a2b3c4d5e6f7a8b9c0d1',
      archiveName: 'Spread 1/portrait.jpg',
    },
  ]);
});
