import { PAYMENT_OPTIONS_KEY, validPaymentOptions, cleanPaymentOptions } from '../services/paymentOptionsService.js';
import { normalizePhone, requirePhone } from '../utils/phone.js';
import { RETENTION_KEY, DEFAULT_RETENTION_DAYS, validRetentionDays } from '../services/orderRetentionPolicy.js';
import { STAFF_VERIFICATION_KEY, DEFAULT_STAFF_VERIFICATION_HOURS, validStaffVerificationHours } from '../services/staffVerificationPolicy.js';
import { requireRecentVerification } from '../services/accessSessionService.js';
import { requestSubmissionDeletion } from '../services/submissionDeletionService.js';
import { TrustedStaffDevice } from '../models/TrustedStaffDevice.model.js';
import staffManagementRoutes from './staffManagement.routes.js';
import { Router } from 'express';
import mongoose from 'mongoose';
import { initialCredentialFields, finishStaffCredentialDelivery, kickStaffCredentials, publicStaff, reissueInitialPassword, retryStaffCredentials, validStaffPhone } from '../services/staffCredentialService.js';
import { MagazineForm } from '../models/MagazineForm.model.js';
import { StaffUser } from '../models/StaffUser.model.js';
import { Order } from '../models/Order.model.js';
import { SystemConfig } from '../models/SystemConfig.model.js';
import { AuditLog } from '../models/AuditLog.model.js';
import { verifyStaffToken, requireRoles } from '../middlewares/auth.middleware.js';
import { getSimulatedNotifications, getNotificationHistory } from '../services/notificationService.js';
import { availableFormSlug } from '../utils/formSlug.js';
import { validateFormForPublication } from '../services/formPublicationService.js';
import { importGoogleForm, importSavedGoogleForm, GoogleFormsImportError } from '../services/googleFormsImportService.js';

import { uploadCover } from '../services/uploadService.js';
import { storeCoverImage } from '../services/coverStorageService.js';

const router = Router();

// Administrators and managers share the magazine form builder.
router.use('/forms', verifyStaffToken, requireRoles('admin', 'manager'));

router.get('/forms', async (req, res) => {
  try {
    const forms = await MagazineForm.find().sort({ createdAt: -1 });
    return res.status(200).json({ success: true, forms });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Upload a magazine cover image
router.post(
  '/forms/upload-cover',
  uploadCover.single('cover'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'Please select an image file to upload' });
      }
      const storedCover = await storeCoverImage(req.file, req.user._id);
      const coverUrl = `/api/public/covers/${storedCover.id}`;
      return res.status(200).json({
        success: true,
        message: 'Cover uploaded successfully',
        coverUrl,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.post('/forms', async (req, res) => {
  try {
    const { title, description, titleSw, descriptionSw, magazineTypeSw, magazineType, price, currency, coverImageUrl, lipaNambaInstructions, sections, fields } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, message: 'Magazine edition title is required' });
    }

    let form;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const cleanSlug = await availableFormSlug(title, (candidate) => MagazineForm.exists({ slug: candidate }));
      try {
        form = await MagazineForm.create({
          title: title.trim(),
          slug: cleanSlug,
          description,
          titleSw: typeof titleSw === 'string' ? titleSw.trim() : '',
          descriptionSw: descriptionSw || '',
          magazineType,
          magazineTypeSw: magazineTypeSw || '',
          price: Number(price) || 50000,
          currency: currency || 'TZS',
          coverImageUrl: typeof coverImageUrl === 'string' ? coverImageUrl.trim() : '',
          lipaNambaInstructions,
          sections: sections || [],
          fields: fields || [],
          isActive: false,
        });
        break;
      } catch (error) {
        if (error.code !== 11000 || !error.keyPattern?.slug) throw error;
      }
    }

    if (!form) {
      return res.status(409).json({ success: false, message: 'Could not reserve a unique edition address. Please try again.' });
    }

    await AuditLog.create({
      actor: { type: req.user.role, id: req.user._id, name: req.user.name },
      action: 'FORM_CREATED',
      details: { slug: form.slug, title: form.title },
    });

    return res.status(201).json({ success: true, message: 'Draft form created successfully', form });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/forms/import-google', async (req, res) => {
  try {
    const savedForm = Object.hasOwn(req.body || {}, 'formData');
    if (!savedForm && (typeof req.body?.url !== 'string' || !req.body.url.trim())) {
      return res.status(400).json({ success: false, message: 'Google Form link is required' });
    }
    const sourceUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const imported = savedForm ? importSavedGoogleForm(req.body.formData, sourceUrl) : await importGoogleForm(sourceUrl);
    let form;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const slug = await availableFormSlug(imported.title, (candidate) => MagazineForm.exists({ slug: candidate }));
      try {
        form = await MagazineForm.create({
          title: imported.title,
          slug,
          description: imported.description,
          sections: imported.sections,
          fields: imported.fields,
          coverImageUrl: '',
          isActive: false,
          importSource: {
            provider: 'google_forms',
            sourceUrl: imported.sourceUrl,
            importedAt: new Date(),
            warnings: imported.warnings,
          },
        });
        break;
      } catch (error) {
        if (error.code !== 11000 || !error.keyPattern?.slug) throw error;
      }
    }
    if (!form) return res.status(409).json({ success: false, message: 'Could not reserve a unique edition address. Please try again.' });

    await AuditLog.create({
      actor: { type: req.user.role, id: req.user._id, name: req.user.name },
      action: 'FORM_IMPORTED',
      details: { formId: form._id, slug: form.slug, provider: 'google_forms', warningCount: imported.warnings.length },
    });
    return res.status(201).json({ success: true, message: 'Google Form imported as a draft', form, warnings: imported.warnings });
  } catch (error) {
    if (error instanceof GoogleFormsImportError) {
      return res.status(error.status).json({ success: false, message: error.message, errorCode: error.code });
    }
    return res.status(500).json({ success: false, message: 'Google Form import failed' });
  }
});

router.put('/forms/:id', async (req, res) => {
  try {
    const { title, description, titleSw, descriptionSw, magazineTypeSw, magazineType, price, currency, coverImageUrl, lipaNambaInstructions, sections, fields } = req.body;
    const currentForm = await MagazineForm.findById(req.params.id);
    if (!currentForm) return res.status(404).json({ success: false, message: 'Form not found' });
    if (currentForm.isArchived) return res.status(409).json({ success: false, message: 'Archived forms cannot be edited' });

    if (currentForm.isActive) {
      const candidate = {
        ...currentForm.toObject(), title, description, magazineType, price, currency,
        coverImageUrl: typeof coverImageUrl === 'string' ? coverImageUrl.trim() : '',
        lipaNambaInstructions, sections: sections || [], fields: fields || [],
      };
      const errors = validateFormForPublication(candidate);
      if (errors.length > 0) return res.status(400).json({ success: false, message: errors[0], errors });
    }

    const form = await MagazineForm.findByIdAndUpdate(
      req.params.id,
      {
        title,
        description,
        titleSw: typeof titleSw === 'string' ? titleSw.trim() : '',
        descriptionSw: descriptionSw || '',
        magazineType,
        magazineTypeSw: magazineTypeSw || '',
        price,
        currency,
        coverImageUrl: typeof coverImageUrl === 'string' ? coverImageUrl.trim() : '',
        lipaNambaInstructions,
        sections: sections || [],
        fields: fields || [],
        $inc: { version: 1 },
      },
      { new: true }
    );

    await AuditLog.create({
      actor: { type: req.user.role, id: req.user._id, name: req.user.name },
      action: 'FORM_UPDATED',
      details: { formId: form._id, slug: form.slug },
    });

    return res.status(200).json({ success: true, message: 'Form updated successfully', form });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/forms/:id/publish', async (req, res) => {
  try {
    const form = await MagazineForm.findById(req.params.id);
    if (!form) return res.status(404).json({ success: false, message: 'Form not found' });
    if (form.isArchived) return res.status(409).json({ success: false, message: 'Archived forms cannot be published' });

    const errors = validateFormForPublication(form);
    if (errors.length > 0) {
      return res.status(400).json({ success: false, message: errors[0], errors });
    }

    form.isActive = true;
    await form.save();
    await AuditLog.create({
      actor: { type: req.user.role, id: req.user._id, name: req.user.name },
      action: 'FORM_PUBLISHED',
      details: { formId: form._id, slug: form.slug, version: form.version },
    });
    return res.status(200).json({ success: true, message: 'Form published successfully', form });
  } catch (error) {
    if (error.name === 'CastError') return res.status(404).json({ success: false, message: 'Form not found' });
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/forms/:id', async (req, res) => {
  try {
    const form = await MagazineForm.findById(req.params.id);
    if (!form) return res.status(404).json({ success: false, message: 'Form not found' });
    if (form.isArchived) return res.status(409).json({ success: false, message: 'Form is already deleted' });

    form.isArchived = true;
    form.isActive = false;
    await form.save();
    await AuditLog.create({
      actor: { type: req.user.role, id: req.user._id, name: req.user.name },
      action: 'FORM_ARCHIVED',
      details: { formId: form._id, slug: form.slug, title: form.title },
    });

    return res.status(200).json({ success: true, message: 'Form deleted from active catalogue', form });
  } catch (error) {
    if (error.name === 'CastError') return res.status(404).json({ success: false, message: 'Form not found' });
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Admin-only for all remaining routes (staff, system config, audit logs)
router.use(verifyStaffToken, requireRoles('admin'));

router.delete('/submissions/:id', requireRecentVerification, async (req, res, next) => {
  try {
    if (req.body?.confirmation !== 'DELETE') {
      return res.status(400).json({ message: 'Confirm permanent deletion of this submission.' });
    }
    const result = await requestSubmissionDeletion(req.params.id, req.user, req.ip);
    return res.status(result.state === 'deleted' ? 200 : 202).json({
      success: true, ...result,
      message: 'Submission removed. File cleanup will finish after active work stops.',
    });
  } catch (error) { next(error); }
});

router.use(staffManagementRoutes);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --- System Config & Audit Logs ---
router.get('/config', async (req, res) => {
  try {
    const configs = await SystemConfig.find();
    if (!configs.some(config => config.key === STAFF_VERIFICATION_KEY)) configs.push({ key: STAFF_VERIFICATION_KEY, value: DEFAULT_STAFF_VERIFICATION_HOURS });
    if (!configs.some(config => config.key === RETENTION_KEY)) configs.push({ key: RETENTION_KEY, value: DEFAULT_RETENTION_DAYS });
    const simulatedNotifs = await getNotificationHistory({ limit: 50 });
    return res.status(200).json({ success: true, configs, simulatedNotifications: simulatedNotifs });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

const CONFIG_KEY_VALIDATORS = {
  [PAYMENT_OPTIONS_KEY]: validPaymentOptions,
  [RETENTION_KEY]: validRetentionDays,
  [STAFF_VERIFICATION_KEY]: validStaffVerificationHours,
  printer_preferred_language: (v) => ['en','sw'].includes(v),
  printer_whatsapp_phone: (v) => Boolean(normalizePhone(v)),
  printer_name: (v) => typeof v === 'string' && v.trim().length <= 120,
  printer_email: (v) => typeof v === 'string' && (v === '' || emailPattern.test(v.trim())),
  payment_instructions: (v) => typeof v === 'string' && v.length <= 2000,
  support_phone: (v) => v === '' || Boolean(normalizePhone(v)),
  support_email: (v) => typeof v === 'string' && (v === '' || emailPattern.test(v.trim())),
  default_max_workload: (v) => Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 20,
};

router.put('/config', (req, res, next) => req.body?.key === STAFF_VERIFICATION_KEY ? requireRecentVerification(req, res, next) : next(), async (req, res) => {
  try {
    const { key, value, description } = req.body || {};
    if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(CONFIG_KEY_VALIDATORS, key)) {
      return res.status(400).json({ success: false, message: 'Unknown configuration key' });
    }
    if (!CONFIG_KEY_VALIDATORS[key](value)) {
      return res.status(400).json({ success: false, message: `Invalid value for ${key}` });
    }
    const cleanValue = key === PAYMENT_OPTIONS_KEY ? cleanPaymentOptions(value) : ['printer_whatsapp_phone', 'support_phone'].includes(key) && value !== '' ? requirePhone(value) : typeof value === 'string' ? value.trim() : value;
    const previous = await SystemConfig.findOne({ key }).lean();
    const config = await SystemConfig.findOneAndUpdate(
      { key },
      {
        key,
        value: cleanValue,
        description: typeof description === 'string' ? description.slice(0, 300) : previous?.description,
        updatedBy: req.user._id,
      },
      { upsert: true, new: true }
    );
    if (key === STAFF_VERIFICATION_KEY && cleanValue === 0) await TrustedStaffDevice.deleteMany({});
    await AuditLog.create({
      actor: { type: req.user.role, id: req.user._id, name: req.user.name },
      action: 'SYSTEM_CONFIG_UPDATED',
      details: { key, previousValue: previous?.value ?? null, newValue: cleanValue },
      ipAddress: req.ip,
    });
    return res.status(200).json({ success: true, message: 'Config updated', config });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/audit-logs', async (req, res) => {
  try {
    const query = req.query.includePageViews === '1' ? {} : { action: { $ne: 'PROOF_PAGE_VIEWED' } };
    const logs = await AuditLog.find(query).sort({ createdAt: -1 }).limit(100).lean();
    return res.status(200).json({ success: true, logs });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
