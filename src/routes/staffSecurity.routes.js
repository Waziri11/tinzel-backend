import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { waitUntil } from '@vercel/functions';
import { StaffUser } from '../models/StaffUser.model.js';
import { AccessSession, AccessChallenge } from '../models/AccessSession.model.js';
import { TrustedStaffDevice } from '../models/TrustedStaffDevice.model.js';
import { SecurityEvent } from '../models/SecurityEvent.model.js';
import { AuditLog } from '../models/AuditLog.model.js';
import { verifyStaffToken, requireRoles } from '../middlewares/auth.middleware.js';
import { digest, cookieValue, setSessionCookie, issueChallenge, consumeChallenge, contactFingerprint, requireRecentVerification } from '../services/accessSessionService.js';
import { authLimits, captcha, captchaConfig, normalizedEmail, assertUncompromisedPassword } from '../services/authProtectionService.js';
import { authEvent, securityAlert, revokeAccountAccess, failedChallengeEvent } from '../services/authActivityService.js';
import { passwordErrors, validStaffPhone, finishStaffCredentialDelivery } from '../services/staffCredentialService.js';
import { formatTanzanianPhone } from '../services/smsService.js';
const router = Router();
const route = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };
const fail = (status, message) => Object.assign(new Error(message), { status });
const snapshot = user => ({ role: user.role, tokenVersion: user.tokenVersion || 0, contactFingerprint: contactFingerprint(user) });
const current = (user, scope) => user?.isActive && !user.deletedAt && user.role === scope?.role && (user.tokenVersion || 0) === scope?.tokenVersion && contactFingerprint(user) === scope?.contactFingerprint;
const activeFilter = (user, scope) => ({ _id: user._id, isActive: true, deletedAt: null, tokenVersion: scope.tokenVersion, role: scope.role, phone: user.phone, email: user.email, passwordHash: user.passwordHash });
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.get('/auth-config', (req, res) => res.json({ captcha: captchaConfig() }));
// Respond before account lookup / provider delivery so their timing and errors cannot disclose membership.
export const pendingRecoveries = new Set();
router.post('/recovery/request', authLimits('recovery', { maxAccount: 5, maxIp: 20 }), captcha('recovery'), route(async (req, res) => {
  const email = normalizedEmail(req.body.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, 'Enter a valid email address.');
  const challengeId = randomBytes(32).toString('hex');
  res.json({ success: true, challengeId, expiresIn: 300, resendAfter: 60, message: 'If an eligible account exists, a verification code will be sent to its registered phone.' });
  const job = (async () => {
    const user = await StaffUser.findOne({ email, isActive: true, deletedAt: null });
    await authEvent(req, 'AUTH_RECOVERY_REQUESTED', user, 'requested');
    if (!user || !validStaffPhone(user.phone)) return;
    try { await issueChallenge({ id: challengeId, subjectId: String(user._id), purpose: 'recovery', channel: 'sms', destination: user.phone, ip: req.ip, scope: snapshot(user), language: user.preferredLanguage }); }
    catch { await authEvent(req, 'AUTH_RECOVERY_DELIVERY_FAILED', user, 'unavailable'); }
  })().catch(() => {});
  pendingRecoveries.add(job); job.finally(() => pendingRecoveries.delete(job)); waitUntil(job);
}));
router.post('/recovery/verify', authLimits('recovery-verify', { account: false }), route(async (req, res) => {
  let challenge;
  try { challenge = await consumeChallenge(req.body.challengeId, req.body.code, 'recovery', req.ip); }
  catch (error) { await failedChallengeEvent(req, 'AUTH_RECOVERY_VERIFY_FAILED', 'recovery'); throw error; }
  const user = await StaffUser.findById(challenge.subjectId);
  if (challenge.channel !== 'sms' || !current(user, challenge.scope)) throw fail(401, 'Recovery has expired. Request a new code.');
  const resetToken = randomBytes(32).toString('hex');
  await AccessChallenge.create({ _id: digest(resetToken), subjectId: String(user._id), purpose: 'password-reset', ready: true, expiresAt: new Date(Date.now() + 300000), scope: challenge.scope });
  await authEvent(req, 'AUTH_RECOVERY_VERIFIED', user);
  res.json({ success: true, resetToken, expiresIn: 300 });
}));
router.post('/recovery/reset', authLimits('recovery-reset', { account: false, maxIp: 20 }), route(async (req, res) => {
  const grant = await AccessChallenge.findOne({ _id: digest(req.body.resetToken), purpose: 'password-reset', consumedAt: null, expiresAt: { $gt: new Date() } });
  const user = grant && await StaffUser.findById(grant.subjectId);
  if (!grant || !current(user, grant.scope)) throw fail(401, 'Recovery has expired. Request a new code.');
  const errors = passwordErrors(req.body.newPassword);
  if (errors.length) throw fail(400, errors.join(' '));
  if (await user.comparePassword(req.body.newPassword)) throw fail(400, 'Choose a different password from your current password.');
  await assertUncompromisedPassword(req.body.newPassword);
  const passwordHash = await bcrypt.hash(req.body.newPassword, 12);
  const claimed = await AccessChallenge.findOneAndUpdate({ _id: grant._id, consumedAt: null, expiresAt: { $gt: new Date() } }, { $set: { consumedAt: new Date() } });
  if (!claimed) throw fail(401, 'Recovery has expired. Request a new code.');
  const updated = await StaffUser.findOneAndUpdate(activeFilter(user, grant.scope), { $set: { passwordHash, passwordChangedAt: new Date(), mustChangePassword: false, temporaryPasswordExpiresAt: null }, $unset: { credentialJob: 1 }, $inc: { tokenVersion: 1 } }, { returnDocument: 'after' });
  if (!updated) throw fail(409, 'The account changed. Start recovery again.');
  await revokeAccountAccess(user._id);
  await finishStaffCredentialDelivery(user._id, user.credentialGeneration || 0);
  await authEvent(req, 'AUTH_PASSWORD_RESET', updated);
  await securityAlert(updated, 'AUTH_PASSWORD_RESET');
  setSessionCookie(res, 'staff', '', 0); setSessionCookie(res, 'staff_device', '', 0);
  res.json({ success: true, message: 'Password reset. Sign in with your new password.' });
}));
router.get('/security', verifyStaffToken, route(async (req, res) => {
  const user = req.user, subjectId = String(user._id), now = new Date();
  const filter = { subjectId, tokenVersion: user.tokenVersion || 0, role: user.role, contactFingerprint: contactFingerprint(user), expiresAt: { $gt: now } };
  const [sessions, devices, events] = await Promise.all([
    AccessSession.find({ ...filter, kind: 'staff', idleUntil: { $gt: now } }).select('_id createdAt lastSeenAt expiresAt browser ipAddress').lean(),
    TrustedStaffDevice.find(filter).select('_id verifiedAt expiresAt browser').lean(),
    SecurityEvent.find({ actorId: subjectId, action: /^AUTH_/ }).sort({ createdAt: -1 }).limit(50).select('eventId action createdAt outcome ipAddress -_id').lean(),
  ]);
  res.json({ sessions: sessions.map(({ _id, ...s }) => ({ ...s, id: _id, current: _id === req.accessSession._id })), devices: devices.map(({ _id, ...d }) => ({ ...d, id: _id, current: _id === digest(cookieValue(req, 'staff_device')) })), events });
}));
router.post('/security/revoke', verifyStaffToken, requireRecentVerification, route(async (req, res) => {
  const { kind, id } = req.body, subjectId = String(req.user._id);
  if (!['session', 'device'].includes(kind) || !/^[a-f0-9]{64}$/.test(id || '')) throw fail(400, 'Choose a session or device.');
  const result = kind === 'session' ? await AccessSession.deleteOne({ _id: id, kind: 'staff', subjectId }) : await TrustedStaffDevice.deleteOne({ _id: id, subjectId });
  if (!result.deletedCount) throw fail(404, 'Session or device is no longer available.');
  await authEvent(req, kind === 'session' ? 'AUTH_SESSION_REVOKED' : 'AUTH_DEVICE_REVOKED', req.user);
  const signedOut = kind === 'session' && id === req.accessSession._id;
  if (signedOut) setSessionCookie(res, 'staff', '', 0);
  if (kind === 'device' && id === digest(cookieValue(req, 'staff_device'))) setSessionCookie(res, 'staff_device', '', 0);
  res.json({ success: true, signedOut });
}));
router.post('/security/revoke-all', verifyStaffToken, requireRecentVerification, route(async (req, res) => {
  await StaffUser.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
  await revokeAccountAccess(req.user._id);
  await authEvent(req, 'AUTH_ALL_ACCESS_REVOKED', req.user);
  setSessionCookie(res, 'staff', '', 0); setSessionCookie(res, 'staff_device', '', 0);
  res.json({ success: true, signedOut: true });
}));
// Administrators may assist managers/designers only. No self-recovery or admin escalation.
router.post('/security/assisted-recovery', verifyStaffToken, requireRoles('admin'), requireRecentVerification, authLimits('assisted', { account: false, maxIp: 10 }), route(async (req, res) => {
  const { email, phone, evidence, identityConfirmed } = req.body;
  if (identityConfirmed !== true || typeof evidence !== 'string' || evidence.trim().length < 20 || evidence.length > 500 || !validStaffPhone(phone)) throw fail(400, 'Confirm identity, record the verification reference, and enter a valid replacement phone.');
  const user = await StaffUser.findOne({ email: normalizedEmail(email), role: { $in: ['manager', 'designer'] }, isActive: true, deletedAt: null });
  if (!user) throw fail(400, 'Choose an active manager or designer account.');
  const destination = formatTanzanianPhone(phone);
  const challenge = await issueChallenge({ subjectId: String(user._id), purpose: 'assisted-contact', channel: 'sms', destination, ip: req.ip, scope: { ...snapshot(user), sessionId: req.accessSession._id, actorId: String(req.user._id), evidence: evidence.trim() }, language: user.preferredLanguage });
  await AuditLog.create({ actor: { type: 'admin', id: String(req.user._id), name: req.user.name }, action: 'AUTH_ASSISTED_RECOVERY_REQUESTED', details: { staffId: String(user._id), evidence: evidence.trim() }, ipAddress: req.ip });
  res.json(challenge);
}));
router.post('/security/assisted-recovery/verify', verifyStaffToken, requireRoles('admin'), requireRecentVerification, route(async (req, res) => {
  const challenge = await consumeChallenge(req.body.challengeId, req.body.code, 'assisted-contact', req.ip);
  const user = await StaffUser.findById(challenge.subjectId);
  if (challenge.scope.sessionId !== req.accessSession._id || challenge.scope.actorId !== String(req.user._id) || !['manager', 'designer'].includes(user?.role) || !current(user, challenge.scope)) throw fail(401, 'Recovery has expired. Start again.');
  const updated = await StaffUser.findOneAndUpdate(activeFilter(user, challenge.scope), { $set: { phone: challenge.destination }, $inc: { tokenVersion: 1 } }, { returnDocument: 'after' });
  if (!updated) throw fail(409, 'The account changed. Start recovery again.');
  await revokeAccountAccess(user._id);
  await AuditLog.create({ actor: { type: 'admin', id: String(req.user._id), name: req.user.name }, action: 'AUTH_ASSISTED_RECOVERY_COMPLETED', details: { staffId: String(user._id), evidence: challenge.scope.evidence }, ipAddress: req.ip });
  await authEvent(req, 'AUTH_ASSISTED_RECOVERY', user);
  await securityAlert(updated, 'AUTH_ASSISTED_RECOVERY', user.phone);
  res.json({ success: true, message: 'Phone verified. The account owner can now use Forgot password.' });
}));
export default router;
