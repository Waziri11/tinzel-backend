import { Router } from 'express';
import { MagazineForm } from '../models/MagazineForm.model.js';
import { Order } from '../models/Order.model.js';
import { AuditLog } from '../models/AuditLog.model.js';
import { uploadPhotos, boundPhotoRequest } from '../services/uploadService.js';
import { respondMediaError } from '../services/mediaErrors.js';
import { generateSubmissionId } from '../services/workflowService.js';
import { validateFormAnswers } from '../services/formResponseService.js';
import { findCoverImage, openCoverImageStream } from '../services/coverStorageService.js';
import { storeOrderPhoto, findOrderPhoto, openOrderPhotoStream } from '../services/photoStorageService.js';
import { notifyOrderSubmitted } from '../services/notificationService.js';

const router = Router();

router.get('/covers/:id', async (req, res) => {
  try {
    const file = await findCoverImage(req.params.id);
    if (!file) return res.status(404).json({ success: false, message: 'Cover image not found' });

    res.setHeader('Content-Type', file.contentType || file.metadata?.contentType || 'application/octet-stream');
    res.setHeader('Content-Length', file.length);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    const stream = openCoverImageStream(req.params.id);
    stream.on('error', (error) => {
      if (!res.headersSent) res.status(500).json({ success: false, message: error.message });
      else res.destroy(error);
    });
    return stream.pipe(res);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/photos/:id', async (req, res) => {
  try {
    const file = await findOrderPhoto(req.params.id);
    if (!file) return res.status(404).json({ success: false, message: 'Photo not found' });

    res.setHeader('Content-Type', file.contentType || file.metadata?.contentType || 'image/jpeg');
    res.setHeader('Content-Length', file.length);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    const stream = openOrderPhotoStream(req.params.id);
    stream.on('error', (error) => {
      if (!res.headersSent) res.status(500).json({ success: false, message: error.message });
      else res.destroy(error);
    });
    return stream.pipe(res);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// List all active public forms
router.get('/forms', async (req, res) => {
  try {
    const forms = await MagazineForm.find({ isActive: true, isArchived: false })
      .select('title titleSw slug description descriptionSw magazineType magazineTypeSw price currency coverImageUrl lipaNambaInstructions sections')
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

// Upload a single order photo before final form submission (avoids 413 Payload Too Large on multi-photo orders)
router.post('/forms/:slug/photos', boundPhotoRequest, (req, res) => {
  uploadPhotos.single('photo')(req, res, async (uploadErr) => {
    if (uploadErr) {
      return respondMediaError(req, res, Object.assign(uploadErr, { status: 400 }));
    }
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'Photo file is required' });
      }

      const slug = String(req.params.slug || '').toLowerCase();
      const fieldId = typeof req.body?.fieldId === 'string' ? req.body.fieldId.trim() : '';
      const folderName =
        typeof req.body?.folderName === 'string' && req.body.folderName.trim()
          ? req.body.folderName.trim()
          : 'General Photos';

      const stored = await storeOrderPhoto(req.file, {
        fieldId,
        folderName,
        formSlug: slug,
      });

      return res.status(201).json({
        success: true,
        photo: {
          url: `/api/public/photos/${stored.id}`,
          originalName: req.file.originalname,
          size: req.file.size,
          fieldId,
          folderName,
          uploadedAt: new Date(),
        },
      });
    } catch (error) {
      return respondMediaError(req, res, error);
    }
  });
});

// Submit magazine form with photos (supports both pre-uploaded photo descriptors and direct multipart files)
router.post('/forms/:slug/submit', boundPhotoRequest, uploadPhotos.array('photos', 50), async (req, res) => {
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
    } else if (formDataRaw.answers && typeof formDataRaw.answers === 'object') {
      parsedData = formDataRaw.answers;
    }

    // Parse pre-uploaded photos if sent as JSON or array
    let preUploadedPhotos = [];
    if (typeof req.body.uploadedPhotos === 'string') {
      try {
        preUploadedPhotos = JSON.parse(req.body.uploadedPhotos);
      } catch (e) {
        preUploadedPhotos = [];
      }
    } else if (Array.isArray(req.body.uploadedPhotos)) {
      preUploadedPhotos = req.body.uploadedPhotos;
    }

    const sanitizedPreUploaded = (Array.isArray(preUploadedPhotos) ? preUploadedPhotos : [])
      .filter((p) => p && typeof p.url === 'string' && /^\/api\/public\/photos\/[a-f0-9]{24}$/i.test(p.url))
      .map((p) => ({
        url: p.url,
        originalName: String(p.originalName || 'photo.jpg'),
        size: Number(p.size) || 0,
        fieldId: String(p.fieldId || ''),
        folderName:
          typeof p.folderName === 'string' && p.folderName.trim()
            ? p.folderName.trim()
            : 'General Photos',
        uploadedAt: new Date(),
      }));

    // Parse photos metadata (maps direct multipart files to question fieldId and folderName)
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

    // Persist any direct multipart photo files into GridFS
    const directUploadedPhotos = [];
    for (const [idx, file] of (req.files || []).entries()) {
        const meta =
          photosMeta.find((m) => m.originalName === file.originalname) ||
          photosMeta[idx] ||
          {};
        const fieldId = meta.fieldId || '';
        const folderName = meta.folderName || 'General Photos';
        const stored = await storeOrderPhoto(file, {
          fieldId,
          folderName,
          formSlug: form.slug,
        });
        directUploadedPhotos.push({
          url: `/api/public/photos/${stored.id}`,
          originalName: file.originalname,
          size: file.size,
          fieldId,
          folderName,
          uploadedAt: new Date(),
        });
    }

    const uploadedPhotos = [...sanitizedPreUploaded, ...directUploadedPhotos];

    const answerErrors = validateFormAnswers(form.fields, parsedData, uploadedPhotos);
    if (answerErrors.length > 0) {
      return res.status(400).json({ success: false, message: answerErrors[0], errors: answerErrors });
    }

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

    await notifyOrderSubmitted(order);

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
