import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allPhotoArchiveEntries, photoArchiveEntries, photoArchiveFileName } from '../src/utils/photoArchive.js';

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

test('whole-order ZIP nests every original under the customer and its question', () => {
  const order = {
    clientName: 'Asha Mushi',
    submittedFields: [{ fieldId: 'family', label: 'Family photos', order: 2 }, { fieldId: 'couple', label: 'Couple photos', order: 1 }],
    uploadedPhotos: [
      { fieldId: 'family', folderName: 'Old family label', url: '/uploads/photos/family.png', originalName: 'family.png' },
      { fieldId: 'couple', folderName: 'Couple photos', url: '/api/public/photos/65f1a2b3c4d5e6f7a8b9c0d1', originalName: 'portrait.jpg' },
      { fieldId: 'couple', folderName: 'Couple photos', url: '/api/public/media/assets/65f1a2b3c4d5e6f7a8b9c0d2', originalName: 'portrait.jpg' },
      { url: '/uploads/photos/legacy.png', originalName: 'extra.png' },
    ],
  };
  const entries = allPhotoArchiveEntries(order, '/tmp/photos');
  assert.deepEqual(entries.map(entry => entry.archiveName), [
    'Asha Mushi/Couple photos/portrait.jpg',
    'Asha Mushi/Couple photos/portrait (2).jpg',
    'Asha Mushi/Family photos/family.png',
    'Asha Mushi/General Photos/extra.png',
  ]);
  assert.equal(entries[1].assetId, '65f1a2b3c4d5e6f7a8b9c0d2');
  assert.equal(photoArchiveFileName(order.clientName, null), 'Asha Mushi.zip');
});

test('distinct questions and unsafe or repeated labels cannot collide or escape the customer folder', () => {
  const labels = ['../Photos', '..\\Photos', 'PHOTOS', 'Photos (2)', 'CON', 'صور'];
  const order = { clientName: '../Asha: Mushi', uploadedPhotos: labels.map((folderName, index) => ({
    fieldId: `question-${index}`, folderName, url: `/uploads/photos/${index}.jpg`, originalName: '..\\portrait?.jpg',
  })) };
  const names = allPhotoArchiveEntries(order, '/tmp/photos').map(entry => entry.archiveName);
  assert.equal(new Set(names.map(name => name.toLowerCase())).size, labels.length);
  for (const name of names) {
    assert.equal(name.split('/').length, 3);
    assert.equal(name.split('/')[0], '_Asha_ Mushi');
    assert.doesNotMatch(name, /[\\<>:"|?*]/);
    assert.ok(!name.split('/').includes('..'));
  }
  assert.ok(names.some(name => name.includes('/_CON/')));
  assert.ok(names.some(name => name.includes('/صور/')));
});

test('identically named questions stay separate, and legacy folders retain all their photos', () => {
  const order = { clientName: '', uploadedPhotos: [
    { fieldId: 'first', folderName: 'Photos', url: '/uploads/photos/1.jpg' },
    { fieldId: 'second', folderName: 'Photos', url: '/uploads/photos/2.jpg' },
    { folderName: 'Photos', url: '/uploads/photos/3.jpg' },
    { folderName: ' Photos ', url: '/uploads/photos/4.jpg' },
  ] };
  const names = allPhotoArchiveEntries(order, '/tmp/photos').map(entry => entry.archiveName);
  assert.deepEqual(names, ['Unnamed customer/Photos/photo-1.jpg', 'Unnamed customer/Photos (2)/photo-1.jpg',
    'Unnamed customer/Photos (3)/photo-1.jpg', 'Unnamed customer/Photos (3)/photo-2.jpg']);
  assert.equal(photoArchiveFileName('', null), 'Unnamed customer.zip');
  assert.deepEqual(allPhotoArchiveEntries({ uploadedPhotos: [] }, '/tmp/photos'), []);
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
