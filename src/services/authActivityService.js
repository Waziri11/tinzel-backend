import { randomUUID } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { Notification } from '../models/Notification.model.js';
import { AccessSession, AccessChallenge } from '../models/AccessSession.model.js';
import { TrustedStaffDevice } from '../models/TrustedStaffDevice.model.js';
import { recordSecurityEvent } from './securityAuditService.js';
import { sendNotification } from './notificationService.js';
import { cookieValue, digest, setSessionCookie, contactFingerprint } from './accessSessionService.js';

const messages = {
  AUTH_NEW_DEVICE: ['A new browser signed in to your Tinzel account.', 'Kivinjari kipya kimeingia kwenye akaunti yako ya Tinzel.'],
  AUTH_PASSWORD_RESET: ['Your Tinzel password was reset. Previous sessions and trusted devices were revoked.', 'Nenosiri lako la Tinzel limewekwa upya. Vipindi na vifaa vilivyoaminika vimeondolewa.'],
  AUTH_PASSWORD_CHANGED: ['Your Tinzel password was changed.', 'Nenosiri lako la Tinzel limebadilishwa.'],
  AUTH_CONTACT_CHANGED: ['Your Tinzel recovery phone was changed.', 'Namba ya simu ya kurejesha akaunti yako ya Tinzel imebadilishwa.'],
  AUTH_ASSISTED_RECOVERY: ['An administrator verified a replacement recovery phone for your Tinzel account.', 'Msimamizi amethibitisha namba mpya ya kurejesha akaunti yako ya Tinzel.'],
};
export function browserLabel(agent = '') {
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox|FxiOS/.test(agent) ? 'Firefox' : /Chrome|CriOS/.test(agent) ? 'Chrome' : /Safari/.test(agent) ? 'Safari' : 'Browser';
  const system = /Android/.test(agent) ? 'Android' : /iPhone|iPad/.test(agent) ? 'iOS' : /Windows/.test(agent) ? 'Windows' : /Macintosh|Mac OS/.test(agent) ? 'macOS' : /Linux/.test(agent) ? 'Linux' : '';
  return system ? `${browser} · ${system}` : browser;
}
export async function failedChallengeEvent(req, action, purpose) {
  const challenge = await AccessChallenge.findOne({ _id: digest(req.body?.challengeId), purpose }).select('subjectId').lean();
  const { StaffUser } = await import('../models/StaffUser.model.js');
  const user = challenge && await StaffUser.findById(challenge.subjectId).select('name role');
  return authEvent(req, action, user, 'denied');
}
export async function authEvent(req, action, user, outcome = 'success') {
  return recordSecurityEvent(req, { action, outcome, ...(user ? { actorId: String(user._id), actorName: user.name, role: user.role } : {}) });
}
export async function securityAlert(user, action, extraPhone) {
  const sw = user.preferredLanguage !== 'en';
  const title = sw ? 'Usalama wa akaunti ya Tinzel' : 'Tinzel account security';
  const message = `${messages[action][sw ? 1 : 0]} ${sw ? 'Kama si wewe, wasiliana na msimamizi wako mara moja.' : 'If this was not you, contact your administrator immediately.'}`;
  const eventGroupId = randomUUID();
  const channels = [['in_system', String(user._id)], ['email', user.email], ...[...new Set([user.phone, extraPhone].filter(Boolean))].map(phone => ['sms', phone])];
  await Notification.insertMany(channels.filter(([, to]) => to).map(([channel, recipient]) => ({
    recipient, channel, recipientName: user.name, recipientRole: user.role, recipientUser: user._id,
    eventGroupId, title, subject: title, message, template: 'auth_security', status: channel === 'in_system' ? 'sent' : 'queued',
    mode: 'auth_security', metadata: { authAlert: true, action },
  })));
  if (process.env.NODE_ENV !== 'test') waitUntil(runAuthAlerts().catch(() => {}));
}
export async function runAuthAlerts({ send = sendNotification } = {}) {
  const rows = await Notification.find({ 'metadata.authAlert': true, channel: { $in: ['email', 'sms'] }, status: { $in: ['queued', 'failed'] }, attempts: { $lt: 5 }, $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: new Date() } }] }).limit(20);
  let count = 0;
  for (const row of rows) {
    const claimed = await Notification.updateOne({ _id: row._id, attempts: row.attempts, 'metadata.sending': { $ne: true } }, { $set: { 'metadata.sending': true, status: 'unconfirmed' }, $inc: { attempts: 1 } });
    if (!claimed.modifiedCount) continue;
    let result;
    try { result = await send({ to: row.recipient, channel: row.channel, subject: row.title, title: row.title, message: row.message, recipientRole: row.recipientRole, template: 'auth_security', metadata: { bypassSettings: true }, skipPersistence: true, fallbackToSms: false }); }
    catch { result = { status: 'unconfirmed' }; }
    await Notification.updateOne({ _id: row._id }, { $set: { status: result.status || 'unconfirmed', mode: result.mode || 'auth_security', 'metadata.sending': false, nextAttemptAt: new Date(Date.now() + 300000) } });
    count++;
  }
  return count;
}
export async function revokeAccountAccess(userId) {
  const subjectId = String(userId);
  await Promise.all([
    AccessSession.deleteMany({ kind: 'staff', subjectId }), TrustedStaffDevice.deleteMany({ subjectId }),
    AccessChallenge.updateMany({ subjectId, consumedAt: null }, { $set: { consumedAt: new Date() } }),
  ]);
}
export async function completeSignIn(req, res, user, token) {
  const known = cookieValue(req, 'staff_known');
  // Recognition is separate from OTP trust and can never authorize access.
  const fingerprint = digest(`${user._id}|${user.tokenVersion || 0}|${contactFingerprint(user)}`);
  const { KnownStaffBrowser } = await import('../models/KnownStaffBrowser.model.js');
  const recognized = /^[a-f0-9]{64}$/.test(known || '') && await KnownStaffBrowser.exists({ _id: digest(known), subjectId: String(user._id), fingerprint, expiresAt: { $gt: new Date() } });
  const sessionId = digest(token);
  await AccessSession.updateOne({ _id: sessionId }, { $set: { createdAt: new Date(), lastSeenAt: new Date(), browser: browserLabel(req.headers['user-agent']), ipAddress: req.ip } });
  await authEvent(req, 'AUTH_LOGIN_SUCCEEDED', user);
  if (!recognized) {
    const { randomBytes } = await import('node:crypto');
    const value = randomBytes(32).toString('hex');
    await KnownStaffBrowser.create({ _id: digest(value), subjectId: String(user._id), fingerprint, expiresAt: new Date(Date.now() + 90 * 86400000) });
    setSessionCookie(res, 'staff_known', value, 90 * 86400000);
    await securityAlert(user, 'AUTH_NEW_DEVICE');
  }
}
