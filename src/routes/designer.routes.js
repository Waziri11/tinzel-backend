import { enqueueProof } from '../services/proofReaderService.js';
import express, { Router } from 'express';
import { DraftUpload } from '../models/DraftUpload.model.js';
import { DRAFT_CHUNK_BYTES, createDraftUpload, getDraftUpload, draftUploadStatus, writeDraftChunk, finishDraftUpload, checkpointDraftUpload } from '../services/draftUploadService.js';
import mongoose from 'mongoose';
import { Order } from '../models/Order.model.js';
import { AuditLog } from '../models/AuditLog.model.js';
import { verifyStaffToken, requireRoles } from '../middlewares/auth.middleware.js';
import { uploadDraft, uploadPrint } from '../services/uploadService.js';
import { photoArchiveFileName } from '../utils/photoArchive.js';
import { MediaJob } from '../models/Media.model.js';
import { enqueueArchive, createPhotoArchive } from '../services/mediaJobService.js';
import { archiveStatus } from './mediaOperations.routes.js';
import { deleteDraftPdf, isPdf, saveDraftPdf, streamDraftPdf } from '../services/draftFileService.js';
import { activeRevisionRequest, assertExpectedVersion } from '../services/revisionRequestService.js';
import { notifyDraftUploaded, notifyPrintDocumentUploaded } from '../services/notificationService.js';

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
    return res.status(error.name === 'VersionError' ? 409 : error.status || 500).json({ success: false, message: error.name === 'VersionError' ? 'This order changed in another session. Refresh before continuing.' : error.message });
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
    return res.status(error.name === 'VersionError' ? 409 : error.status || 500).json({ success: false, message: error.name === 'VersionError' ? 'This order changed in another session. Refresh before continuing.' : error.message });
  }
});

router.get('/returns', async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const status = req.query.status || 'active';
    const sourceFilter = req.query.source || 'all';
    const search = (req.query.search || '').trim().toLowerCase();

    const query = { 'revisionRequests.0': { $exists: true } };
    if (req.user.role === 'designer') query.assignedDesigner = req.user._id;

    const orders = await Order.find(query)
      .select('submissionId trackingId clientName clientWhatsApp formTitle status currentDraftVersion revisionRequests assignedDesigner updatedAt')
      .populate('assignedDesigner', 'name email phone')
      .sort({ updatedAt: -1 })
      .lean();

    const allRows = orders.flatMap((order) =>
      (order.revisionRequests || []).map((request) => ({
        orderId: order._id,
        trackingId: order.trackingId || order.submissionId,
        submissionId: order.submissionId,
        clientName: order.clientName,
        clientWhatsApp: order.clientWhatsApp,
        formTitle: order.formTitle,
        orderStatus: order.status,
        currentDraftVersion: order.currentDraftVersion,
        assignedDesigner: order.assignedDesigner,
        ...request,
      }))
    );

    const summary = {
      open: allRows.filter((r) => r.status === 'open').length,
      submitted_for_review: allRows.filter((r) => r.status === 'submitted_for_review').length,
      active: allRows.filter((r) => r.status !== 'resolved').length,
      resolved: allRows.filter((r) => r.status === 'resolved').length,
      manager: allRows.filter((r) => r.source === 'manager' && r.status !== 'resolved').length,
      client: allRows.filter((r) => r.source === 'client' && r.status !== 'resolved').length,
    };

    const filteredRows = allRows.filter((request) => {
      if (status === 'resolved' && request.status !== 'resolved') return false;
      if (status === 'active' && request.status === 'resolved') return false;
      if (status === 'open' && request.status !== 'open') return false;
      if (status === 'submitted_for_review' && request.status !== 'submitted_for_review') return false;
      if (sourceFilter !== 'all' && request.source !== sourceFilter) return false;
      if (search) {
        const hay = [
          request.trackingId,
          request.submissionId,
          request.clientName,
          request.formTitle,
          request.assignedDesigner?.name,
          ...(request.items || []).map((i) => i.text),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    const total = filteredRows.length;
    const pagedRows = filteredRows.slice((page - 1) * limit, page * limit);

    return res.json({
      success: true,
      returns: pagedRows,
      summary,
      total,
      page,
      pageCount: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) { return res.status(error.name === 'VersionError' ? 409 : error.status || 500).json({ success: false, message: error.name === 'VersionError' ? 'This order changed in another session. Refresh before continuing.' : error.message }); }
});

// Get single order with complete client assets & revision notes
router.get('/orders/:id', async (req, res) => {
  try {
    const order = await req.order.populate(['formId', { path: 'assignedDesigner', select: 'name email' }]);

    const auditLogs = await AuditLog.find({ orderId: order._id }).sort({ createdAt: -1 }).lean();
    return res.status(200).json({ success: true, order, auditLogs });
  } catch (error) {
    return res.status(error.name === 'VersionError' ? 409 : error.status || 500).json({ success: false, message: error.name === 'VersionError' ? 'This order changed in another session. Refresh before continuing.' : error.message });
  }
});

router.get('/orders/:id/drafts/:version/view', async (req, res) => {
  const draft = req.order.draftVersions.find((item) => item.versionNumber === Number(req.params.version));
  if (!draft) return res.status(404).json({ success: false, message: 'Draft version not found' });
  try { return streamDraftPdf(res, draft); } catch (error) { return res.status(error.name === 'VersionError' ? 409 : error.status || 500).json({ success: false, message: error.message }); }
});

router.get('/orders/:id/drafts/:version/download', requireRoles('manager', 'admin'), async (req, res) => {
  const draft = req.order.draftVersions.find((item) => item.versionNumber === Number(req.params.version));
  if (!draft) return res.status(404).json({ success: false, message: 'Draft version not found' });
  try { return streamDraftPdf(res, draft, { download: true }); } catch (error) { return res.status(error.name === 'VersionError' ? 409 : error.status || 500).json({ success: false, message: error.message }); }
});

router.patch('/orders/:id/returns/:requestId/items/:itemId', requireRoles('designer', 'admin'), async (req, res) => {
  try {
    const request = req.order.revisionRequests.id(req.params.requestId);
    const item = request?.items.id(req.params.itemId);
    if (!request || !item || request.status !== 'open') return res.status(404).json({ success: false, message: 'Open fix item not found' });
    const response = String(req.body.response || '').trim();
    if (!response) return res.status(400).json({ success: false, message: 'Describe how this fix was addressed' });
    item.status = 'addressed'; item.designerResponse = response; item.addressedBy = req.user._id; item.addressedAt = new Date();
    await req.order.save();
    await AuditLog.create({ actor: { type: req.user.role, id: req.user._id, name: req.user.name }, action: 'CORRECTION_ITEM_ADDRESSED', orderId: req.order._id,
      details: { requestId: request._id, itemId: item._id, roundNumber: request.roundNumber } });
    return res.json({ success: true, request });
  } catch (error) { return res.status(error.name === 'VersionError' ? 409 : error.status || 500).json({ success: false, message: error.message }); }
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
  catch (error) { if (res.headersSent) res.destroy(error); else res.status(error.name === 'VersionError' ? 409 : error.status || 500).json({ message: error.message }); }
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
        actor: { type: req.user.role, id: req.user._id, name: req.user.name },
        action: 'DESIGN_STARTED',
        orderId: order._id,
      });
    }

    return res.status(200).json({ success: true, message: 'Design status updated to in_design', order });
  } catch (error) {
    return res.status(error.name === 'VersionError' ? 409 : error.status || 500).json({ success: false, message: error.name === 'VersionError' ? 'This order changed in another session. Refresh before continuing.' : error.message });
  }
});

// Small authenticated requests keep large PDFs below the hosting gateway's body limit.
const draftRoute = (handler) => async (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  try { await handler(req, res); } catch (error) { next(error); }
};
router.post('/orders/:id/draft-uploads', requireRoles('designer','admin'), draftRoute(async (req,res) => {
  const session = await createDraftUpload(req.order,req.user,req.body);
  res.status(201).json(await draftUploadStatus(session));
}));
router.get('/orders/:id/draft-uploads/:uploadId', requireRoles('designer','admin'), draftRoute(async (req,res) => {
  res.json(await draftUploadStatus(await getDraftUpload(req.params.uploadId,req.order._id,req.user._id)));
}));
router.put('/orders/:id/draft-uploads/:uploadId/chunks/:n', requireRoles('designer','admin'), express.raw({type:'application/octet-stream',limit:DRAFT_CHUNK_BYTES}), draftRoute(async (req,res) => {
  const session=await getDraftUpload(req.params.uploadId,req.order._id,req.user._id);
  await writeDraftChunk(session,Number(req.params.n),req.body,req.get('X-Chunk-SHA256'));
  res.json({success:true});
}));
router.post('/orders/:id/draft-uploads/:uploadId/checkpoint', requireRoles('designer','admin'), draftRoute(async (req,res)=>{
  const session=await getDraftUpload(req.params.uploadId,req.order._id,req.user._id);
  res.json(await checkpointDraftUpload(session,req.body));
}));
router.post('/orders/:id/draft-uploads/:uploadId/complete', requireRoles('designer','admin'), draftRoute(async (req,res) => {
  res.json(await finishDraftUpload(await getDraftUpload(req.params.uploadId,req.order._id,req.user._id),req.user));
}));
router.delete('/orders/:id/draft-uploads/:uploadId', requireRoles('designer','admin'), draftRoute(async (req,res) => {
  const session=await getDraftUpload(req.params.uploadId,req.order._id,req.user._id);
  const result=await DraftUpload.updateOne({_id:session._id,state:'open'},{$set:{state:'cancelled',expiresAt:new Date(Date.now()+(session.provider==='blob'?3600000:0))}});
  if(!result.modifiedCount)return res.status(409).json({message:'This upload is being finalized or is already complete. Refresh the order.'});
  res.json({success:true});
}));

// Upload Draft (PDF / Spreads)
router.post(
  '/orders/:id/upload-draft',
  requireRoles('designer', 'admin'),
  uploadDraft.single('draftFile'),
  async (req, res) => {
    let assetId;
    try {
      const order = req.order;
      if (!['assigned', 'in_design', 'revision_requested'].includes(order.status)) {
        return res.status(409).json({ success: false, message: `A draft cannot be uploaded while the order is ${order.status.replaceAll('_', ' ')}` });
      }
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'Draft file is required' });
      }
      if (!isPdf(req.file)) return res.status(400).json({ success: false, message: 'Drafts must be valid PDF files' });
      assertExpectedVersion(order, req.body.expectedVersion);
      const activeReturn = activeRevisionRequest(order);
      if (activeReturn?.status === 'submitted_for_review') return res.status(409).json({ success: false, message: 'This return is already awaiting manager review' });
      if (activeReturn) {
        if (String(req.body.revisionRequestId || '') !== String(activeReturn._id)) return res.status(409).json({ success: false, message: 'Refresh and use the current return checklist' });
        if (req.body.verifyAll !== 'true' || activeReturn.items.some((item) => item.status !== 'addressed')) {
          return res.status(400).json({ success: false, message: 'Address and verify every requested fix before uploading' });
        }
      }

      const nextVersion = (order.currentDraftVersion || 0) + 1;
      assetId = await saveDraftPdf(req.file, order._id, nextVersion);

      order.draftVersions.push({
        versionNumber: nextVersion,
        assetId,
        originalName: req.file.originalname,
        mimeType: 'application/pdf',
        size: req.file.size,
        revisionRequestId: activeReturn?._id,
        uploadedBy: req.user._id,
        uploadedAt: new Date(),
        designerNotes: req.body.designerNotes || '',
        managerReview: {
          status: 'pending',
        },
      });

      if (activeReturn) {
        activeReturn.status = 'submitted_for_review';
        activeReturn.submittedVersionNumber = nextVersion;
        activeReturn.submittedAt = new Date();
      }

      order.currentDraftVersion = nextVersion;
      // PRD Gate: draft enters draft_manager_review and is NOT yet visible to client!
      order.status = 'draft_manager_review';
      await order.save();

      await AuditLog.create({
        actor: { type: req.user.role, id: req.user._id, name: req.user.name },
        action: 'DRAFT_UPLOADED',
        orderId: order._id,
        details: {
          versionNumber: nextVersion,
          assetId: String(assetId),
          revisionRequestId: activeReturn?._id,
        },
      });

      await enqueueProof(order._id, nextVersion);
      await notifyDraftUploaded(order, nextVersion);

      return res.status(200).json({
        success: true,
        message: `Draft Version ${nextVersion} uploaded successfully. Awaiting manager review.`,
        order,
      });
    } catch (error) {
      if (assetId && !await Order.exists({ 'draftVersions.assetId': assetId })) await deleteDraftPdf(assetId);
      return res.status(error.name === 'VersionError' ? 409 : error.status || 500).json({ success: false, message: error.message });
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

    await notifyPrintDocumentUploaded(order);

    return res.status(200).json({
      success: true,
      message: 'Print-ready document uploaded. Ready for manager print authorization.',
      order,
    });
  } catch (error) {
    return res.status(error.name === 'VersionError' ? 409 : error.status || 500).json({ success: false, message: error.name === 'VersionError' ? 'This order changed in another session. Refresh before continuing.' : error.message });
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
    return res.status(error.name === 'VersionError' ? 409 : error.status || 500).json({ success: false, message: error.name === 'VersionError' ? 'This order changed in another session. Refresh before continuing.' : error.message });
  }
});

export default router;
