import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSubmissionId,
  generateUniqueSubmissionId,
  validateTransition,
  sanitizeOrderForClient,
} from '../src/services/workflowService.js';

test('Workflow Gate: Submission ID format matches SUB-YYYY-XXXXX', () => {
  const subId = generateSubmissionId();
  const year = new Date().getFullYear();
  assert.match(subId, new RegExp(`^SUB-${year}-\\d{5}$`));
});

test('Workflow Gate: Cryptographic submission IDs are formatted and distinct', async () => {
  const year = new Date().getFullYear();
  const id1 = await generateUniqueSubmissionId();
  const id2 = await generateUniqueSubmissionId();
  assert.match(id1, new RegExp(`^SUB-${year}-\\d{5,6}$`));
  assert.match(id2, new RegExp(`^SUB-${year}-\\d{5,6}$`));
  assert.notEqual(id1, id2);
});

test('Workflow Gate: State machine transition rules are strictly enforced', () => {
  // Awaiting payment can only transition to payment_verified, on_hold, or closed
  assert.equal(validateTransition('awaiting_payment', 'payment_verified'), true);
  assert.equal(validateTransition('awaiting_payment', 'in_design'), false);
  assert.equal(validateTransition('awaiting_payment', 'client_review'), false);

  // Draft cannot jump straight to client_review without draft_manager_review
  assert.equal(validateTransition('in_design', 'draft_manager_review'), true);
  assert.equal(validateTransition('in_design', 'client_review'), false);

  // Client review can transition to client_approved or revision_requested
  assert.equal(validateTransition('client_review', 'client_approved'), true);
  assert.equal(validateTransition('client_review', 'revision_requested'), true);
  assert.equal(validateTransition('client_review', 'printing_sent'), false);

  // Print document requires client approval before manager print review
  assert.equal(validateTransition('client_approved', 'print_document_prep'), true);
  assert.equal(validateTransition('print_document_prep', 'print_manager_review'), true);
  assert.equal(validateTransition('print_manager_review', 'printing_sent'), true);
});

test('Workflow Gate: Sanitizer hides unreleased drafts from client portal', () => {
  const mockOrderInDesign = {
    trackingId: 'TNZ-2026-0001',
    status: 'draft_manager_review',
    draftVersions: [
      {
        versionNumber: 1,
        fileUrl: '/uploads/drafts/draft1.pdf',
        managerReview: { status: 'pending' },
      },
    ],
  };

  const sanitizedBeforeRelease = sanitizeOrderForClient(mockOrderInDesign);
  assert.equal(sanitizedBeforeRelease.draftVersions.length, 0, 'Unreleased draft must be hidden from client');

  const mockOrderReleased = {
    trackingId: 'TNZ-2026-0001',
    status: 'client_review',
    currentDraftVersion: 1,
    draftVersions: [
      {
        versionNumber: 1,
        fileUrl: '/uploads/drafts/draft1.pdf',
        managerReview: { status: 'approved' },
      },
    ],
    revisionRequests: [
      { _id: 'manager-return', source: 'manager', status: 'resolved', items: [{ text: 'Internal change' }] },
      { _id: 'client-return', source: 'client', roundNumber: 2, status: 'open', items: [{ _id: 'item-1', text: 'Client change', pageReference: '3', status: 'open', designerResponse: 'internal response' }] },
    ],
  };

  const sanitizedAfterRelease = sanitizeOrderForClient(mockOrderReleased);
  assert.equal(sanitizedAfterRelease.draftVersions.length, 1, 'Released draft must be visible to client');
  assert.equal(sanitizedAfterRelease.draftVersions[0].versionNumber, 1);
  assert.equal(sanitizedAfterRelease.draftVersions[0].fileUrl, undefined, 'Storage URL must not be exposed');
  assert.equal(sanitizedAfterRelease.revisionRequests.length, 1, 'Only client-authored return history is visible');
  assert.equal(sanitizedAfterRelease.revisionRequests[0].items[0].designerResponse, undefined, 'Internal designer responses stay private');
});
