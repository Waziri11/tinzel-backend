import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMediaError } from '../src/services/mediaErrors.js';
import { boundPhotoRequest } from '../src/services/uploadService.js';

test('media errors distinguish permanent failures, limits, and transient storage failure', () => {
  assert.equal(classifyMediaError({ code: 13 }).retryable, false);
  assert.equal(classifyMediaError({ name: 'MongoNetworkTimeoutError' }).status, 503);
  assert.equal(classifyMediaError({ code: 'LIMIT_FILE_SIZE', status: 400 }).status, 413);
  assert.equal(classifyMediaError({ status: 409 }).retryable, false);
});
test('legacy uploads are bounded before multer allocates buffers', () => {
  let status, next = false;
  const res = { status(value) { status = value; return this; }, json() {} };
  boundPhotoRequest({ is: () => true, headers: { 'content-length': 6000000 } }, res, () => { next = true; });
  assert.equal(status, 413);
  assert.equal(next, false);
  boundPhotoRequest({ is: () => false, headers: {} }, res, () => { next = true; });
  assert.equal(next, true);
});
