import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Order } from '../src/models/Order.model.js';
import { activeRevisionRequest, assertExpectedVersion, closeActiveRevision, createRevisionRequest, normalizeCorrectionItems } from '../src/services/revisionRequestService.js';
import { isPdf } from '../src/services/draftFileService.js';

const order = () => new Order({ _id: new mongoose.Types.ObjectId(), submissionId: `SUB-2026-${Math.random()}`, formId: new mongoose.Types.ObjectId(), clientName: 'Client', clientWhatsApp: '0712000000', currentDraftVersion: 2 });

test('correction requests preserve separate checklist items and allow only one active round', () => {
  const value = order();
  const request = createRevisionRequest(value, { source: 'manager', actor: { type: 'manager', name: 'Manager' }, items: normalizeCorrectionItems({ items: [{ text: 'Fix cover', pageReference: '1' }, { text: 'Correct name' }] }) });
  assert.equal(request.items.length, 2);
  assert.equal(activeRevisionRequest(value).roundNumber, 1);
  assert.throws(() => createRevisionRequest(value, { source: 'client', actor: { type: 'client' }, items: [{ text: 'Another' }] }), /already has an active return/);
  closeActiveRevision(value, 'released');
  assert.equal(activeRevisionRequest(value), undefined);
});

test('legacy feedback becomes one item and stale versions are rejected', () => {
  assert.deepEqual(normalizeCorrectionItems({ feedback: 'Adjust page 3' }), [{ text: 'Adjust page 3', pageReference: '' }]);
  assert.doesNotThrow(() => assertExpectedVersion(order(), 2));
  assert.throws(() => assertExpectedVersion(order(), 1), /changed in another session/);
});

test('draft validation requires PDF name, MIME type and file signature', () => {
  const valid = { originalname: 'draft.pdf', mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.7') };
  assert.equal(isPdf(valid), true);
  assert.equal(isPdf({ ...valid, originalname: 'draft.png' }), false);
  assert.equal(isPdf({ ...valid, mimetype: 'image/png' }), false);
  assert.equal(isPdf({ ...valid, buffer: Buffer.from('not a pdf') }), false);
});
