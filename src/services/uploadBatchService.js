import { createHash } from 'node:crypto';

// Stay below the hosting gateway limit, even without transport compression.
export const UPLOAD_BATCH_PARTS = 3;
export const MAX_UPLOAD_BATCH_BYTES = 3 * 1024 * 1024;
const fail = (status, message) => Object.assign(new Error(message), { status });
export const uploadHash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function writeUploadBatch({ bytes, start, size, chunkBytes, expectedHash, write }) {
  const remaining = size - start * chunkBytes;
  if (!Number.isInteger(start) || start < 0 || remaining <= 0 || !Buffer.isBuffer(bytes) ||
      !bytes.length || bytes.length > Math.min(MAX_UPLOAD_BATCH_BYTES, remaining) ||
      (bytes.length !== remaining && bytes.length % chunkBytes !== 0)) {
    throw fail(400, 'Invalid upload batch');
  }
  if (uploadHash(bytes) !== expectedHash) throw fail(409, 'Upload verification failed. Retry this batch.');
  // Each stored part retains its original size and hash, so old uploads still resume.
  await Promise.all(Array.from({ length: Math.ceil(bytes.length / chunkBytes) }, (_, offset) => {
    const part = bytes.subarray(offset * chunkBytes, (offset + 1) * chunkBytes);
    return write(start + offset, part, uploadHash(part));
  }));
}

export function readUploadMetadata(header) {
  try {
    if (typeof header !== 'string' || header.length > 8192) throw new Error();
    const value = JSON.parse(decodeURIComponent(header));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw fail(400, 'Invalid upload details'); }
}
