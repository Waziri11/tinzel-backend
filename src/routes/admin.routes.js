import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { MagazineForm } from '../models/MagazineForm.model.js';
import { StaffUser } from '../models/StaffUser.model.js';
import { Order } from '../models/Order.model.js';
import { SystemConfig } from '../models/SystemConfig.model.js';
import { AuditLog } from '../models/AuditLog.model.js';
import { verifyStaffToken, requireRoles } from '../middlewares/auth.middleware.js';
import { getSimulatedNotifications, getNotificationHistory } from '../services/notificationService.js';
import { availableFormSlug } from '../utils/formSlug.js';
import { validateFormForPublication } from '../services/formPublicationService.js';
import { importGoogleForm, GoogleFormsImportError } from '../services/googleFormsImportService.js';

import { uploadCover } from '../services/uploadService.js';
import { storeCoverImage } from '../services/coverStorageService.js';

const router = Router();

// --- Dynamic Form Builder Endpoints (Administrator owned) ---
router.get('/forms', verifyStaffToken, requireRoles('admin'), async (req, res) => {
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
  verifyStaffToken,
  requireRoles('admin'),
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

router.post('/forms', verifyStaffToken, requireRoles('admin'), async (req, res) => {
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

router.post('/forms/import-google', verifyStaffToken, requireRoles('admin'), async (req, res) => {
  try {
    if (typeof req.body?.url !== 'string' || !req.body.url.trim()) {
      return res.status(400).json({ success: false, message: 'Google Form link is required' });
    }
    const imported = await importGoogleForm(req.body.url.trim());
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
      return res.status(error.status).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: 'Google Form import failed' });
  }
});

router.put('/forms/:id', verifyStaffToken, requireRoles('admin'), async (req, res) => {
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

router.post('/forms/:id/publish', verifyStaffToken, requireRoles('admin'), async (req, res) => {
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

router.delete('/forms/:id', verifyStaffToken, requireRoles('admin'), async (req, res) => {
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

// --- Staff Management & Workload Endpoints ---
const staffRoles = ['admin', 'manager', 'designer'];
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const publicStaff = (user) => {
  const data = user.toObject();
  delete data.passwordHash;
  return data;
};
const logStaffChange = (req, action, user) => AuditLog.create({
  actor: { type: req.user.role, id: req.user._id, name: req.user.name },
  action,
  details: { staffId: user._id, name: user.name, role: user.role },
});
const activeDesignerOrder = (id) => Order.exists({
  assignedDesigner: id,
  status: { $nin: ['delivered', 'closed'] },
});

router.get('/staff', async (req, res) => {
  try {
    const staff = await StaffUser.find({ deletedAt: null }).select('-passwordHash').sort({ role: 1, name: 1 });
    return res.status(200).json({ success: true, staff });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/staff/:id', async (req, res) => {
  try {
    const user = await StaffUser.findOne({ _id: req.params.id, deletedAt: null }).select('-passwordHash');
    if (!user) return res.status(404).json({ success: false, message: 'Staff user not found' });
    return res.status(200).json({ success: true, user });
  } catch (error) {
    if (error.name === 'CastError') return res.status(404).json({ success: false, message: 'Staff user not found' });
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/staff', async (req, res) => {
  try {
    const { name, email, password, role, phone, maxActiveWorkload, isEligibleForAssignment } = req.body;
    if (typeof name !== 'string' || !name.trim() || typeof email !== 'string' || !emailPattern.test(email.trim()) || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ success: false, message: 'Name, valid email, and a password of at least 8 characters are required' });
    }
    if (!staffRoles.includes(role)) return res.status(400).json({ success: false, message: 'Choose a valid internal role' });
    if (role === 'designer' && maxActiveWorkload !== undefined && (!Number.isInteger(Number(maxActiveWorkload)) || Number(maxActiveWorkload) < 1 || Number(maxActiveWorkload) > 20)) {
      return res.status(400).json({ success: false, message: 'Designer capacity must be between 1 and 20' });
    }

    const existing = await StaffUser.findOne({ email: email.trim().toLowerCase() });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await StaffUser.create({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      passwordHash,
      role,
      phone: typeof phone === 'string' ? phone.trim() : '',
      maxActiveWorkload: role === 'designer' && maxActiveWorkload !== undefined ? Number(maxActiveWorkload) : 5,
      isEligibleForAssignment: isEligibleForAssignment !== false,
    });

    await logStaffChange(req, 'STAFF_CREATED', user);
    return res.status(201).json({
      success: true,
      message: 'Staff account created successfully',
      user: publicStaff(user),
    });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ success: false, message: 'Email already registered' });
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/staff/:id', async (req, res) => {
  try {
    const user = await StaffUser.findOne({ _id: req.params.id, deletedAt: null });
    if (!user) return res.status(404).json({ success: false, message: 'Staff user not found' });
    const wasActiveAdmin = user.role === 'admin' && user.isActive;
    const previousRole = user.role;
    const previousActive = user.isActive;
    let shouldRevokeSessions = false;

    const { name, email, role, phone, isActive, maxActiveWorkload, isEligibleForAssignment, password } = req.body;
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ success: false, message: 'Name is required' });
      user.name = name.trim();
    }
    if (email !== undefined) {
      if (typeof email !== 'string' || !emailPattern.test(email.trim())) return res.status(400).json({ success: false, message: 'Valid email is required' });
      user.email = email.trim().toLowerCase();
    }
    if (role !== undefined) {
      if (!staffRoles.includes(role)) return res.status(400).json({ success: false, message: 'Choose a valid internal role' });
      if (role !== previousRole) shouldRevokeSessions = true;
      user.role = role;
    }
    if (phone !== undefined) {
      if (typeof phone !== 'string') return res.status(400).json({ success: false, message: 'Phone must be text' });
      user.phone = phone.trim();
    }
    if (isActive !== undefined) {
      if (typeof isActive !== 'boolean') return res.status(400).json({ success: false, message: 'Status must be active or inactive' });
      if (isActive !== previousActive && !isActive) shouldRevokeSessions = true;
      user.isActive = isActive;
    }
    if (isEligibleForAssignment !== undefined) {
      if (typeof isEligibleForAssignment !== 'boolean') return res.status(400).json({ success: false, message: 'Assignment status must be true or false' });
      user.isEligibleForAssignment = isEligibleForAssignment;
    }
    if (maxActiveWorkload !== undefined) {
      if (!Number.isInteger(Number(maxActiveWorkload)) || Number(maxActiveWorkload) < 1 || Number(maxActiveWorkload) > 20) return res.status(400).json({ success: false, message: 'Designer capacity must be between 1 and 20' });
      user.maxActiveWorkload = Number(maxActiveWorkload);
    }
    if (password !== undefined && password !== '') {
      if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
      user.passwordHash = await bcrypt.hash(password, 10);
      shouldRevokeSessions = true;
    }
    if (shouldRevokeSessions) {
      user.tokenVersion = (user.tokenVersion || 0) + 1;
    }
    if (String(user._id) === String(req.user._id) && (user.role !== 'admin' || !user.isActive)) return res.status(409).json({ success: false, message: 'You cannot remove your own administrator access' });
    if (wasActiveAdmin && (user.role !== 'admin' || !user.isActive)) {
      const otherAdmins = await StaffUser.countDocuments({ _id: { $ne: user._id }, role: 'admin', isActive: true, deletedAt: null });
      if (!otherAdmins) return res.status(409).json({ success: false, message: 'At least one active administrator is required' });
    }
    if (user.role !== 'designer' || !user.isActive) {
      if (await activeDesignerOrder(user._id)) return res.status(409).json({ success: false, message: 'Reassign this designer’s open orders before changing their role or access' });
    }
    await user.save();
    await logStaffChange(req, 'STAFF_UPDATED', user);
    return res.status(200).json({ success: true, message: 'Staff user updated', user: publicStaff(user) });
  } catch (error) {
    if (error.name === 'CastError') return res.status(404).json({ success: false, message: 'Staff user not found' });
    if (error.code === 11000) return res.status(409).json({ success: false, message: 'Email already registered' });
    if (error.name === 'ValidationError') return res.status(400).json({ success: false, message: error.message });
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/staff/:id', async (req, res) => {
  try {
    const user = await StaffUser.findOne({ _id: req.params.id, deletedAt: null });
    if (!user) return res.status(404).json({ success: false, message: 'Staff user not found' });
    if (String(user._id) === String(req.user._id)) return res.status(409).json({ success: false, message: 'You cannot delete your own account' });
    if (user.role === 'admin' && user.isActive) {
      const otherAdmins = await StaffUser.countDocuments({ _id: { $ne: user._id }, role: 'admin', isActive: true, deletedAt: null });
      if (!otherAdmins) return res.status(409).json({ success: false, message: 'At least one active administrator is required' });
    }
    if (await activeDesignerOrder(user._id)) return res.status(409).json({ success: false, message: 'Reassign this designer’s open orders before deleting their account' });
    user.isActive = false;
    user.deletedAt = new Date();
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    await logStaffChange(req, 'STAFF_DELETED', user);
    return res.status(200).json({ success: true, message: 'Staff account deleted' });
  } catch (error) {
    if (error.name === 'CastError') return res.status(404).json({ success: false, message: 'Staff user not found' });
    return res.status(500).json({ success: false, message: error.message });
  }
});

// --- System Config & Audit Logs ---
router.get('/config', async (req, res) => {
  try {
    const configs = await SystemConfig.find();
    const simulatedNotifs = await getNotificationHistory({ limit: 50 });
    return res.status(200).json({ success: true, configs, simulatedNotifications: simulatedNotifs });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

const CONFIG_KEY_VALIDATORS = {
  printer_whatsapp_phone: (v) => typeof v === 'string' && /^\+?[\d\s-]{9,20}$/.test(v.trim()),
  printer_name: (v) => typeof v === 'string' && v.trim().length <= 120,
  printer_email: (v) => typeof v === 'string' && (v === '' || emailPattern.test(v.trim())),
  payment_instructions: (v) => typeof v === 'string' && v.length <= 2000,
  support_phone: (v) => typeof v === 'string' && (v === '' || /^\+?[\d\s-]{9,20}$/.test(v.trim())),
  support_email: (v) => typeof v === 'string' && (v === '' || emailPattern.test(v.trim())),
  default_max_workload: (v) => Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 20,
};

router.put('/config', async (req, res) => {
  try {
    const { key, value, description } = req.body || {};
    if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(CONFIG_KEY_VALIDATORS, key)) {
      return res.status(400).json({ success: false, message: 'Unknown configuration key' });
    }
    if (!CONFIG_KEY_VALIDATORS[key](value)) {
      return res.status(400).json({ success: false, message: `Invalid value for ${key}` });
    }
    const cleanValue = typeof value === 'string' ? value.trim() : value;
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
