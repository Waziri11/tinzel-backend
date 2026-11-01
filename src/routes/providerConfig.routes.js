import { Router } from 'express';
import {
  verifyStaffToken,
  requireRoles,
} from '../middlewares/auth.middleware.js';
import { ProviderConfig } from '../models/ProviderConfig.model.js';
import { AuditLog } from '../models/AuditLog.model.js';
import {
  PROVIDER_FIELDS,
  providerMetadata,
  encryptProviderSecret,
  validateProviderValue,
  invalidateProviderSettings,
  refreshProviderSettings,
} from '../services/providerConfigService.js';
import { clearSystemSummaryCache } from '../services/systemSummaryService.js';
import { getNextSMSHealth } from '../services/smsService.js';
import { getEmailHealth } from '../services/emailService.js';
import { testTwilioConnection } from '../services/notificationService.js';
import { createRateLimiter } from '../middlewares/rateLimiter.js';
const router = Router();
router.use(verifyStaffToken, requireRoles('admin'));
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
router.get('/', async (_req, res) => {
  try {
    res.json({ success: true, providers: await providerMetadata() });
  } catch {
    res.status(503).json({ message: 'Provider settings unavailable.' });
  }
});
router.put('/:provider', async (req, res) => {
  try {
    const fields = Object.hasOwn(PROVIDER_FIELDS, req.params.provider)
      ? PROVIDER_FIELDS[req.params.provider]
      : null;
    if (!fields)
      return res.status(404).json({ message: 'Provider not found.' });
    const { values = {}, remove = [], revision } = req.body || {};
    if (
      !values ||
      typeof values !== 'object' ||
      Array.isArray(values) ||
      !Array.isArray(remove) ||
      remove.some((k) => typeof k !== 'string' || !Object.hasOwn(fields, k)) ||
      Object.keys(values).some((k) => !Object.hasOwn(fields, k)) ||
      Object.keys(req.body).some(
        (k) => !['values', 'remove', 'revision'].includes(k),
      )
    )
      return res.status(400).json({ message: 'Invalid provider fields.' });
    let row = await ProviderConfig.findOne({
      provider: req.params.provider,
    }).select('+secrets');
    if ((row?.__v ?? null) !== revision)
      return res
        .status(409)
        .json({ message: 'Settings changed. Reload before saving.' });
    if (!row) row = new ProviderConfig({ provider: req.params.provider });
    const nextValues = { ...(row.values || {}) },
      nextSecrets = { ...(row.secrets || {}) },
      changed = [];
    for (const [name, value] of Object.entries(values)) {
      if (typeof value !== 'string')
        return res
          .status(400)
          .json({ message: 'Provider values must be text.' });
      if (!value.trim()) continue;
      const clean = validateProviderValue(name, value);
      if (fields[name]) nextSecrets[name] = encryptProviderSecret(clean, name);
      else nextValues[name] = clean;
      changed.push(name);
    }
    for (const name of remove) {
      delete nextValues[name];
      delete nextSecrets[name];
      changed.push(name);
    }
    row.values = nextValues;
    row.secrets = nextSecrets;
    row.updatedBy = req.user._id;
    row.markModified('values');
    row.markModified('secrets');
    await row.save();
    invalidateProviderSettings();
    clearSystemSummaryCache();
    await AuditLog.create({
      actor: { type: 'admin', id: req.user._id, name: req.user.name },
      action: 'PROVIDER_CONFIG_UPDATED',
      details: {
        provider: row.provider,
        fields: [...new Set(changed)],
        removed: remove,
      },
    });
    res.json({ success: true, providers: await providerMetadata() });
  } catch (error) {
    res
      .status(
        error.name === 'VersionError' || error.code === 11000
          ? 409
          : error.status || 500,
      )
      .json({
        message: error.status
          ? error.message
          : error.name === 'VersionError' || error.code === 11000
            ? 'Settings changed. Reload before saving.'
            : 'Unable to save provider settings.',
      });
  }
});
router.post(
  '/:provider/check',
  createRateLimiter({
    scope: 'provider-check',
    maxAttempts: 10,
    windowMs: 60000,
    keyGenerator: (req) => String(req.user._id),
  }),
  async (req, res) => {
    const checks = {
      nextsms: getNextSMSHealth,
      smtp: getEmailHealth,
      twilio: testTwilioConnection,
    };
    if (!Object.hasOwn(checks, req.params.provider))
      return res.status(404).json({ message: 'Provider not found.' });
    try {
      await refreshProviderSettings(true);
      const result = await checks[req.params.provider]();
      const connected = Boolean(
        result.authenticated || result.connected || result.success,
      );
      res.json({
        success: true,
        configured: !!result.configured,
        connected,
        checkedAt: new Date().toISOString(),
      });
    } catch {
      res.status(503).json({
        message:
          'Connection check unavailable. Check provider settings and encryption configuration.',
      });
    }
  },
);
export default router;
