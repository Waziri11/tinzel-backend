import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { MagazineForm } from '../models/MagazineForm.model.js';
import { StaffUser } from '../models/StaffUser.model.js';
import { SystemConfig } from '../models/SystemConfig.model.js';
import { AuditLog } from '../models/AuditLog.model.js';
import { verifyStaffToken, requireRoles } from '../middlewares/auth.middleware.js';
import { getSimulatedNotifications } from '../services/notificationService.js';

const router = Router();

// Admin-only for all routes
router.use(verifyStaffToken, requireRoles('admin'));

// --- Dynamic Form Builder Endpoints ---
router.get('/forms', async (req, res) => {
  try {
    const forms = await MagazineForm.find().sort({ createdAt: -1 });
    return res.status(200).json({ success: true, forms });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/forms', async (req, res) => {
  try {
    const { title, slug, description, magazineType, price, currency, lipaNambaInstructions, fields } = req.body;
    if (!title || !slug) {
      return res.status(400).json({ success: false, message: 'Title and unique slug are required' });
    }

    const cleanSlug = slug.toLowerCase().trim().replace(/[^a-z0-9-]/g, '-');
    const existing = await MagazineForm.findOne({ slug: cleanSlug });
    if (existing) {
      return res.status(400).json({ success: false, message: 'A form with this slug already exists' });
    }

    const form = await MagazineForm.create({
      title,
      slug: cleanSlug,
      description,
      magazineType,
      price: Number(price) || 50000,
      currency: currency || 'TZS',
      lipaNambaInstructions,
      fields: fields || [],
    });

    await AuditLog.create({
      actor: { type: 'admin', id: req.user._id, name: req.user.name },
      action: 'FORM_CREATED',
      details: { slug: cleanSlug, title },
    });

    return res.status(201).json({ success: true, message: 'Form created successfully', form });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/forms/:id', async (req, res) => {
  try {
    const { title, description, magazineType, price, currency, lipaNambaInstructions, fields, isActive, isArchived } = req.body;

    const form = await MagazineForm.findByIdAndUpdate(
      req.params.id,
      {
        title,
        description,
        magazineType,
        price,
        currency,
        lipaNambaInstructions,
        fields,
        isActive,
        isArchived,
        $inc: { version: 1 },
      },
      { new: true }
    );

    if (!form) {
      return res.status(404).json({ success: false, message: 'Form not found' });
    }

    await AuditLog.create({
      actor: { type: 'admin', id: req.user._id, name: req.user.name },
      action: 'FORM_UPDATED',
      details: { formId: form._id, slug: form.slug },
    });

    return res.status(200).json({ success: true, message: 'Form updated successfully', form });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/forms/:id', async (req, res) => {
  try {
    const form = await MagazineForm.findByIdAndUpdate(
      req.params.id,
      { isArchived: true, isActive: false },
      { new: true }
    );

    if (!form) {
      return res.status(404).json({ success: false, message: 'Form not found' });
    }

    return res.status(200).json({ success: true, message: 'Form archived', form });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// --- Staff Management & Workload Endpoints ---
router.get('/staff', async (req, res) => {
  try {
    const staff = await StaffUser.find().select('-passwordHash').sort({ role: 1, name: 1 });
    return res.status(200).json({ success: true, staff });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/staff', async (req, res) => {
  try {
    const { name, email, password, role, phone, maxActiveWorkload, isEligibleForAssignment } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Name, email, and password are required' });
    }

    const existing = await StaffUser.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await StaffUser.create({
      name,
      email: email.toLowerCase(),
      passwordHash,
      role: role || 'designer',
      phone: phone || '',
      maxActiveWorkload: Number(maxActiveWorkload) || 5,
      isEligibleForAssignment: isEligibleForAssignment !== false,
    });

    return res.status(201).json({
      success: true,
      message: 'Staff account created successfully',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        currentActiveWorkload: user.currentActiveWorkload,
        maxActiveWorkload: user.maxActiveWorkload,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/staff/:id', async (req, res) => {
  try {
    const { name, role, phone, isActive, maxActiveWorkload, isEligibleForAssignment, password } = req.body;
    const updates = { name, role, phone, isActive, maxActiveWorkload, isEligibleForAssignment };

    if (password) {
      updates.passwordHash = await bcrypt.hash(password, 10);
    }

    const user = await StaffUser.findByIdAndUpdate(req.params.id, updates, { new: true }).select('-passwordHash');
    if (!user) {
      return res.status(404).json({ success: false, message: 'Staff user not found' });
    }

    return res.status(200).json({ success: true, message: 'Staff user updated', user });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// --- System Config & Audit Logs ---
router.get('/config', async (req, res) => {
  try {
    const configs = await SystemConfig.find();
    const simulatedNotifs = getSimulatedNotifications();
    return res.status(200).json({ success: true, configs, simulatedNotifications: simulatedNotifs });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/config', async (req, res) => {
  try {
    const { key, value, description } = req.body;
    const config = await SystemConfig.findOneAndUpdate(
      { key },
      { key, value, description, updatedBy: req.user._id },
      { upsert: true, new: true }
    );
    return res.status(200).json({ success: true, message: 'Config updated', config });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/audit-logs', async (req, res) => {
  try {
    const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(100);
    return res.status(200).json({ success: true, logs });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
