import { randomBytes } from 'node:crypto';
import { SystemConfig } from '../models/SystemConfig.model.js';
import { TrustedStaffDevice } from '../models/TrustedStaffDevice.model.js';
import { cookieValue, setSessionCookie, digest, contactFingerprint } from './accessSessionService.js';

export const STAFF_VERIFICATION_KEY = 'staff_login_verification_hours';
export const DEFAULT_STAFF_VERIFICATION_HOURS = 168;
export const STAFF_VERIFICATION_INTERVALS = [0, 1, 6, 12, 24, 72, 168, 336, 720];
export const validStaffVerificationHours = value => typeof value === 'number' && STAFF_VERIFICATION_INTERVALS.includes(value);

export async function staffVerificationHours() {
  const config = await SystemConfig.findOne({ key: STAFF_VERIFICATION_KEY }).lean();
  // Missing means the documented default; malformed stored policy fails closed.
  return config ? (validStaffVerificationHours(config.value) ? config.value : 0) : DEFAULT_STAFF_VERIFICATION_HOURS;
}

export async function trustedStaffVerification(req, user) {
  const token = cookieValue(req, 'staff_device');
  if (!/^[a-f0-9]{64}$/.test(token || '')) return null;
  const hours = await staffVerificationHours();
  if (!hours) return null;
  const device = await TrustedStaffDevice.findOne({
    _id: digest(token), subjectId: String(user._id), role: user.role,
    tokenVersion: user.tokenVersion || 0, contactFingerprint: contactFingerprint(user),
    expiresAt: { $gt: new Date() },
    verifiedAt: { $gt: new Date(Date.now() - hours * 3600000), $lte: new Date() },
  }).lean();
  return device?.verifiedAt || null;
}

export async function rememberStaffVerification(req, res, user, verifiedAt) {
  const hours = await staffVerificationHours();
  const previous = cookieValue(req, 'staff_device');
  if (/^[a-f0-9]{64}$/.test(previous || '')) {
    await TrustedStaffDevice.deleteOne({ _id: digest(previous), subjectId: String(user._id) });
  }
  if (!hours) {
    setSessionCookie(res, 'staff_device', '', 0);
    return;
  }
  const token = randomBytes(32).toString('hex');
  const maxAge = hours * 3600000;
  await TrustedStaffDevice.create({
    _id: digest(token), subjectId: String(user._id), role: user.role,
    tokenVersion: user.tokenVersion || 0, contactFingerprint: contactFingerprint(user),
    verifiedAt, expiresAt: new Date(+verifiedAt + maxAge),
  });
  setSessionCookie(res, 'staff_device', token, maxAge);
}
