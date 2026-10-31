const FRONTEND = 'https://tinzel.stryxis.com';
const BACKEND = 'https://tinzel-backend.stryxis.com';

function origin(value, { local = false } = {}) {
  if (!value) return '';
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
    const loopback = /^(localhost|127(?:\.\d+){3}|\[::1\]|0\.0\.0\.0)$/.test(url.hostname) || url.hostname.endsWith('.localhost');
    if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) return '';
    if (!local && (loopback || url.protocol !== 'https:')) return '';
    return url.origin;
  } catch { return ''; }
}

// Outbound links must stay usable even when a development URL was left in hosting settings.
export const notificationFrontendUrl = () => origin(process.env.FRONTEND_URL) || FRONTEND;
export const notificationBackendUrl = requestBase => origin(process.env.BACKEND_URL)
  || (process.env.NODE_ENV !== 'production' && process.env.VERCEL !== '1' ? origin(requestBase, { local: true }) : '')
  || BACKEND;

export function notificationTrackingUrl(value) {
  try {
    const parsed = new URL(value);
    if (origin(value)) return parsed.toString();
  } catch { /* Use the public tracking page. */ }
  return `${notificationFrontendUrl()}/track`;
}
