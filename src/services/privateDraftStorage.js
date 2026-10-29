import { Readable } from 'node:stream';
import { head, get, del } from '@vercel/blob';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';
export const BLOB_PART_BYTES = 8 * 1024 * 1024;
const credentials = () => {
  const token = process.env.DRAFT_BLOB_READ_WRITE_TOKEN;
  if (!token) throw Object.assign(new Error('Private draft storage is not configured'), { status: 503 });
  return token;
};
// Adapter injection is confined to tests; production methods always require the private store credential.
export const privateDraftStorage = {
  async authorize(session) {
    const validUntil = Math.min(Date.now() + 3600000, +new Date(session.expiresAt));
    const token = await generateClientTokenFromReadWriteToken({ token: credentials(), pathname: session.blobPath,
      maximumSizeInBytes: session.size, allowedContentTypes: ['application/pdf'], validUntil, allowOverwrite: false, addRandomSuffix: false });
    return { token, validUntil };
  },
  async inspect(pathname) {
    const info = await head(pathname, { token: credentials() });
    if (info.pathname !== pathname || !new URL(info.url).hostname.endsWith('.private.blob.vercel-storage.com')) {
      throw Object.assign(new Error('Draft storage must be a private Blob store'), { status: 503 });
    }
    return info;
  },
  async range(pathname, start, end, signal) {
    const result = await get(pathname, { token: credentials(), access: 'private', useCache: true, abortSignal: signal, headers: { Range: `bytes=${start}-${end - 1}` } });
    if (!result?.stream || !result.headers.get('content-range')?.startsWith(`bytes ${start}-${end - 1}/`)) {
      await result?.stream?.cancel();
      throw Object.assign(new Error('Private storage did not return the requested byte range'), { code: 'PROOF_STORAGE_UNAVAILABLE' });
    }
    return Readable.fromWeb(result.stream);
  },
  async remove(pathname) { await del(pathname, { token: credentials() }); },
};
