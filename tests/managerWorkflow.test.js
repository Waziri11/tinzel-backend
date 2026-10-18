import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requireStatus,
  validatePayment,
  validateDraftDecision,
  validatePrinterStage,
  validateDispatch,
  validateDelivery,
  isConfiguredPhone,
} from '../src/services/managerWorkflowService.js';

test('manager payment verification requires a real reference and positive amount', () => {
  assert.deepEqual(validatePayment({ lipaNambaReference: ' QK-123 ', amountPaid: '50000' }), { reference: 'QK-123', amount: 50000 });
  assert.throws(() => validatePayment({ lipaNambaReference: '', amountPaid: 50000 }), /reference is required/);
  assert.throws(() => validatePayment({ lipaNambaReference: 'QK-123', amountPaid: 0 }), /greater than zero/);
});

test('manager workflow gates reject out-of-sequence actions', () => {
  assert.doesNotThrow(() => requireStatus({ status: 'printing_completed' }, ['printing_completed'], 'Dispatch'));
  assert.throws(() => requireStatus({ status: 'in_design' }, ['printing_completed'], 'Dispatch'), /not available/);
});

test('returning a draft and logging printer progress require meaningful notes', () => {
  assert.throws(() => validateDraftDecision({ action: 'return_to_designer', feedback: '' }), /instructions are required/);
  assert.throws(() => validatePrinterStage({ stage: 'completed', notes: '' }), /printer reply/);
});

test('dispatch and delivery require real operational evidence', () => {
  assert.throws(() => validateDispatch({ carrier: 'Courier', trackingReference: '', deliveryAddress: 'Dar' }), /tracking reference/);
  assert.throws(() => validateDelivery({ recipientName: 'Asha', confirmationMethod: '', recipientFeedback: 'Received' }), /Choose how/);
  assert.equal(isConfiguredPhone('+255712345678'), true);
  assert.equal(isConfiguredPhone('0712345678'), false);
});
