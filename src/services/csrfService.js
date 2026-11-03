import { timingSafeEqual } from 'node:crypto';

export const isSafeMethod = method => ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());

// CORS and CSRF must use exactly the same trusted frontend origins.
export function isAllowedOrigin(origin) {
  if (typeof origin !== 'string' || !origin || origin === 'null') return false;
  const allowed = [process.env.FRONTEND_URL, ...(process.env.ALLOWED_ORIGINS || '').split(',')]
    .map(value => value?.trim()).filter(Boolean);
  return allowed.includes(origin) || (process.env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin));
}

export function csrfError(code) {
  return Object.assign(new Error('Request verification failed. Refresh the page and try again.'), { status: 403, code });
}

export function verifySessionCsrf(req, expected) {
  if (!isAllowedOrigin(req.headers.origin)) throw csrfError('CSRF_ORIGIN_INVALID');
  const supplied = req.headers['x-csrf-token'];
  if (typeof expected !== 'string' || !/^[a-f0-9]{48}$/.test(expected) ||
      typeof supplied !== 'string' || !/^[a-f0-9]{48}$/.test(supplied) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) {
    throw csrfError('CSRF_TOKEN_INVALID');
  }
}

// Login/recovery have no authenticated session yet. Reject browser form posts
// and foreign origins before they can issue credentials or send a challenge.
export function protectAuthenticationEntry(req, res, next) {
  if (isSafeMethod(req.method)) return next();
  if ((req.headers.origin && !isAllowedOrigin(req.headers.origin)) ||
      (!req.headers.origin && req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'none') ||
      !req.is('application/json')) return next(csrfError('CSRF_ORIGIN_INVALID'));
  next();
}
