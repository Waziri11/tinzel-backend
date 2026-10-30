import jwt from 'jsonwebtoken';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getJwtSecret } from '../middlewares/auth.middleware.js';

function cleanBasePath(rawUrl) {
  return String(rawUrl || '').split('?')[0].trim();
}

export function computeMediaSignature(basePath, expiresUnix) {
  return createHmac('sha256', getJwtSecret())
    .update(`${cleanBasePath(basePath)}:${Number(expiresUnix)}`)
    .digest('hex');
}

export function signMediaPath(rawUrl, ttlSeconds = 3600) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  const basePath = cleanBasePath(rawUrl);
  if (
    !basePath.startsWith('/api/public/photos/') &&
    !basePath.startsWith('/api/public/media/assets/') &&
    !basePath.startsWith('/api/designer/orders/') &&
    !basePath.startsWith('/uploads/')
  ) {
    return rawUrl;
  }
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = computeMediaSignature(basePath, exp);
  return `${basePath}?exp=${exp}&sig=${sig}`;
}

export function verifySignedMediaRequest(req) {
  const { exp, sig } = req.query || {};
  if (exp !== undefined || sig !== undefined) {
    const expNum = Number.parseInt(String(exp || ''), 10);
    const sigStr = String(sig || '').trim();
    if (!Number.isInteger(expNum) || expNum < Math.floor(Date.now() / 1000) || !/^[a-f0-9]{64}$/i.test(sigStr)) {
      return { valid: false, explicit: true };
    }
    const basePath = cleanBasePath(req.originalUrl || req.baseUrl + req.path);
    const expected = computeMediaSignature(basePath, expNum);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(sigStr, 'utf8');
    const ok = a.length === b.length && timingSafeEqual(a, b);
    return { valid: ok, explicit: true };
  }

  const authHeader = String(req.headers?.authorization || '');
  if (authHeader.startsWith('Bearer ')) {
    try {
      jwt.verify(authHeader.slice(7).trim(), getJwtSecret());
      return { valid: true, explicit: true };
    } catch {
      return { valid: false, explicit: true };
    }
  }

  if (req.headers?.['x-upload-token']) {
    return { valid: true, explicit: true };
  }

  const enforceStrict =
    process.env.NODE_ENV === 'production' || process.env.REQUIRE_SCOPED_MEDIA_ACCESS === 'true';
  return { valid: !enforceStrict, explicit: false };
}
