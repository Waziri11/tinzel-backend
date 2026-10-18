import { Router } from 'express';
import mongoose from 'mongoose';
import { Order } from '../models/Order.model.js';
import { AuditLog } from '../models/AuditLog.model.js';
import { verifyStaffToken, requireRoles } from '../middlewares/auth.middleware.js';
import { uploadDraft, uploadPrint } from '../services/uploadService.js';
import { photoArchiveFileName } from '../utils/photoArchive.js';
import { MediaJob } from '../models/Media.model.js';
import { enqueueArchive, createPhotoArchive } from '../services/mediaJobService.js';
import { archiveStatus } from './mediaOperations.routes.js';

const router = Router();

// Managers may inspect production assets; only designers/admins may mutate design work.
router.use(verifyStaffToken, requireRoles('designer', 'manager', 'admin'));

router.param('id', async (req, res, next, id) => {
  try {
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (req.user.role === 'designer' && String(order.assignedDesigner) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'This order is not assigned to you' });
    }
    req.order = order;
    next();
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Get all orders assigned to current designer
router.get('/orders', async (req, res) => {
  try {
    const filter = { assignedDesigner: req.user._id };
    if (req.user.role === 'admin' || req.user.role === 'manager') {
      if (req.query.designerId) {
        filter.assignedDesigner = req.query.designerId;
      } else {
        delete filter.assignedDesigner;
      }
    }

    const orders = await Order.find(filter)
      .select('submissionId trackingId clientName formTitle status updatedAt assignedDesigner')
      .sort({ updatedAt: -1 });

    return res.status(200).json({ success: true, count: orders.length, orders });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Get single order with complete client assets & revision notes
router.get('/orders/:id', async (req, res) => {
  try {
    const order = await req.order.populate(['formId', { path: 'assignedDesigner', select: 'name email' }]);

    return res.status(200).json({ success: true, order });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// New clients prepare a cached archive and use a normal browser download.
router.post('/orders/:id/photo-folder-download', async (req, res, next) => {
  try {
    if (typeof req.body.folder !== 'string') return res.status(400).json({ message: 'Choose a photo folder' });
    const job = await enqueueArchive(req.order, req.body.folder);
    res.status(job.state === 'ready' ? 200 : 202).json(await archiveStatus(job, req.user, req.order));
  } catch (error) { next(error); }
});
router.get('/orders/:id/media-jobs/:jobId', async (req, res, next) => {
  try {
    let job = await MediaJob.findById(req.params.jobId).lean();
    if (job?.state === 'expired' && String(job.orderId) === String(req.order._id)) job = await enqueueArchive(req.order, job.folder);
    const status = await archiveStatus(job, req.user, req.order);
    if (!status) return res.status(404).json({ message: 'Download not found' });
    res.json(status);
  } catch (error) { next(error); }
});

// Keep older clients working, with bounded streaming and no image recompression.
router.get('/orders/:id/photo-folder.zip', async (req, res) => {
  if (typeof req.query.folder !== 'string' || !req.query.folder.trim()) return res.status(400).json({ message: 'Choose a photo folder' });
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${photoArchiveFileName(req.order.trackingId || req.order.submissionId, req.query.folder)}"`);
  try { await createPhotoArchive(req.order, req.query.folder, res, controller.signal); }
  catch (error) { if (res.headersSent) res.destroy(error); else res.status(error.status || 500).json({ message: error.message }); }
});

// Start Design
router.post('/orders/:id/start-design', requireRoles('designer', 'admin'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.status === 'assigned' || order.status === 'revision_requested') {
      order.status = 'in_design';
      await order.save();

      await AuditLog.create({
        actor: { type: 'designer', id: req.user._id, name: req.user.name },
        action: 'DESIGN_STARTED',
        orderId: order._id,
      });
    }

    return res.status(200).json({ success: true, message: 'Design status updated to in_design', order });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Upload Draft (PDF / Spreads)
router.post(
  '/orders/:id/upload-draft',
  requireRoles('designer', 'admin'),
  uploadDraft.fields([
    { name: 'draftFile', maxCount: 1 },
    { name: 'previewPages', maxCount: 20 },
  ]),
  async (req, res) => {
    try {
      const order = await Order.findById(req.params.id);
      if (!order) {
        return res.status(404).json({ success: false, message: 'Order not found' });
      }

      if (!req.files || !req.files.draftFile || req.files.draftFile.length === 0) {
        return res.status(400).json({ success: false, message: 'Draft file is required' });
      }

      const draftFile = req.files.draftFile[0];
      const draftUrl = `/uploads/drafts/${draftFile.filename}`;

      // Preview page images for whole-magazine flip reader
      const previewPages = (req.files.previewPages || []).map(
        (f) => `/uploads/drafts/${f.filename}`
      );

      // If no preview images uploaded separately, use draftFile itself as page 1
      if (previewPages.length === 0) {
        previewPages.push(draftUrl);
      }

      const nextVersion = (order.currentDraftVersion || 0) + 1;

      order.draftVersions.push({
        versionNumber: nextVersion,
        fileUrl: draftUrl,
        previewPages,
        uploadedBy: req.user._id,
        uploadedAt: new Date(),
        designerNotes: req.body.designerNotes || '',
        managerReview: {
          status: 'pending',
        },
      });

      order.currentDraftVersion = nextVersion;
      // PRD Gate: draft enters draft_manager_review and is NOT yet visible to client!
      order.status = 'draft_manager_review';
      await order.save();

      await AuditLog.create({
        actor: { type: 'designer', id: req.user._id, name: req.user.name },
        action: 'DRAFT_UPLOADED',
        orderId: order._id,
        details: {
          versionNumber: nextVersion,
          draftUrl,
          previewPagesCount: previewPages.length,
        },
      });

      return res.status(200).json({
        success: true,
        message: `Draft Version ${nextVersion} uploaded successfully. Awaiting manager review.`,
        order,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

// Upload Final Print Document
router.post('/orders/:id/upload-print-document', requireRoles('designer', 'admin'), uploadPrint.single('printFile'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.status !== 'client_approved' && order.status !== 'print_document_prep') {
      return res.status(400).json({
        success: false,
        message: 'Cannot upload print document until whole magazine is client-approved',
      });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Print file is required' });
    }

    const printUrl = `/uploads/print/${req.file.filename}`;

    const specs = {
      quantity: Number(req.body.quantity) || 1,
      paperType: req.body.paperType || 'Glossy 150gsm',
      coverFinish: req.body.coverFinish || 'Laminated Matte',
      binding: req.body.binding || 'Saddle Stitch',
    };

    order.printDocument = {
      url: printUrl,
      uploadedBy: req.user._id,
      uploadedAt: new Date(),
      specs,
    };

    order.status = 'print_manager_review';
    await order.save();

    await AuditLog.create({
      actor: { type: 'designer', id: req.user._id, name: req.user.name },
      action: 'PRINT_DOCUMENT_UPLOADED',
      orderId: order._id,
      details: { printUrl, specs },
    });

    return res.status(200).json({
      success: true,
      message: 'Print-ready document uploaded. Ready for manager print authorization.',
      order,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Flag Issue with order
router.post('/orders/:id/flag-issue', requireRoles('designer', 'admin'), async (req, res) => {
  try {
    const { issue } = req.body;
    if (!issue) {
      return res.status(400).json({ success: false, message: 'Issue description is required' });
    }

    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    order.holdReason = `Designer Flag: ${issue}`;
    await order.save();

    await AuditLog.create({
      actor: { type: 'designer', id: req.user._id, name: req.user.name },
      action: 'DESIGNER_FLAGGED_ISSUE',
      orderId: order._id,
      details: { issue },
    });

    return res.status(200).json({ success: true, message: 'Issue flagged for manager review', order });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
