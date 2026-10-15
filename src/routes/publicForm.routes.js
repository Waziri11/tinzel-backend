import { Router } from 'express';
import { MagazineForm } from '../models/MagazineForm.model.js';
import { Order } from '../models/Order.model.js';
import { AuditLog } from '../models/AuditLog.model.js';
import { uploadPhotos } from '../services/uploadService.js';
import { generateSubmissionId } from '../services/workflowService.js';

const router = Router();

// List all active public forms
router.get('/forms', async (req, res) => {
  try {
    const forms = await MagazineForm.find({ isActive: true, isArchived: false })
      .select('title slug description magazineType price currency coverImageUrl lipaNambaInstructions sections')
      .sort({ createdAt: -1 });

    return res.status(200).json({ success: true, forms });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Get single active form by slug
router.get('/forms/:slug', async (req, res) => {
  try {
    const form = await MagazineForm.findOne({
      slug: req.params.slug.toLowerCase(),
      isActive: true,
      isArchived: false,
    });

    if (!form) {
      return res.status(404).json({ success: false, message: 'Magazine form not found or inactive' });
    }

    return res.status(200).json({ success: true, form });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Submit magazine form with photos
router.post('/forms/:slug/submit', uploadPhotos.array('photos', 30), async (req, res) => {
  try {
    const form = await MagazineForm.findOne({
      slug: req.params.slug.toLowerCase(),
      isActive: true,
      isArchived: false,
    });

    if (!form) {
      return res.status(404).json({ success: false, message: 'Magazine form not found' });
    }

    const { clientName, clientWhatsApp, clientEmail, ...formDataRaw } = req.body;

    if (!clientName || !clientWhatsApp) {
      return res.status(400).json({
        success: false,
        message: 'Client name and WhatsApp number are required',
      });
    }

    // Parse submitted form data if JSON encoded
    let parsedData = formDataRaw;
    if (typeof formDataRaw.answers === 'string') {
      try {
        parsedData = JSON.parse(formDataRaw.answers);
      } catch (e) {
        parsedData = formDataRaw;
      }
    }

    // Parse photos metadata (maps files to question fieldId and folderName)
    let photosMeta = [];
    if (typeof req.body.photosMetadata === 'string') {
      try {
        photosMeta = JSON.parse(req.body.photosMetadata);
      } catch (e) {
        photosMeta = [];
      }
    } else if (Array.isArray(req.body.photosMetadata)) {
      photosMeta = req.body.photosMetadata;
    }

    // Process uploaded photo attachments
    const uploadedPhotos = (req.files || []).map((file, idx) => {
      const meta =
        photosMeta.find((m) => m.originalName === file.originalname) ||
        photosMeta[idx] ||
        {};
      return {
        url: `/uploads/photos/${file.filename}`,
        originalName: file.originalname,
        size: file.size,
        fieldId: meta.fieldId || '',
        folderName: meta.folderName || 'General Photos',
        uploadedAt: new Date(),
      };
    });

    const submissionId = generateSubmissionId();

    const order = await Order.create({
      submissionId,
      formId: form._id,
      formTitle: form.title,
      clientName: clientName.trim(),
      clientWhatsApp: clientWhatsApp.trim(),
      clientEmail: clientEmail ? clientEmail.trim() : '',
      submittedData: parsedData,
      submittedFields: (form.fields || []).map((field) => ({
        fieldId: field.fieldId,
        label: field.label,
        sectionId: field.sectionId,
        order: field.order,
      })),
      uploadedPhotos,
      status: 'awaiting_payment',
    });

    await AuditLog.create({
      actor: { type: 'client', name: clientName },
      action: 'ORDER_SUBMITTED',
      orderId: order._id,
      details: {
        submissionId,
        formSlug: form.slug,
        photosCount: uploadedPhotos.length,
      },
      ipAddress: req.ip,
    });

    return res.status(201).json({
      success: true,
      message: 'Magazine submission received successfully. Please complete payment.',
      order: {
        submissionId: order.submissionId,
        formTitle: form.title,
        price: form.price,
        currency: form.currency,
        status: order.status,
        clientName: order.clientName,
        clientWhatsApp: order.clientWhatsApp,
        photosCount: uploadedPhotos.length,
      },
      lipaNambaInstructions: form.lipaNambaInstructions,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
