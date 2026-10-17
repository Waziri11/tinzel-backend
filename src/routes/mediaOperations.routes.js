import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { pipeline } from 'node:stream/promises';
import { StaffUser } from '../models/StaffUser.model.js';
import { Order } from '../models/Order.model.js';
import { MediaJob, MediaDownloadTicket } from '../models/Media.model.js';
import { digest } from '../services/mediaSessionService.js';
import { runMediaJobs, cleanExpiredUploads } from '../services/mediaJobService.js';
import { photoArchiveFileName } from '../utils/photoArchive.js';

export async function archiveStatus(job, user, order) {
  if (!job || String(job.orderId) !== String(order._id)) return null;
  if (job.state !== 'ready') return { jobId: job._id, state: job.state, message: job.state === 'failed' ? 'This folder could not be prepared. Please contact staff.' : 'Preparing your folder' };
  const available = await MediaJob.updateOne({ _id: job._id, state: 'ready' }, { $set: { lastDownloadAt: new Date() } });
  if (!available.matchedCount) return { jobId: job._id, state: 'expired' };
  const token = randomBytes(32).toString('hex');
  await MediaDownloadTicket.create({ _id: digest(token), staffId: user._id, orderId: order._id, jobId: job._id, expiresAt: new Date(Date.now() + 10 * 60000) });
  return { jobId: job._id, state: 'ready', url: `/api/media-download/${token}` };
}
const router = Router();
router.get('/internal/media-jobs', async (req, res) => {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.sendStatus(401);
  try {
    const result = await runMediaJobs();
    if (process.env.MEDIA_CLEANUP_ENABLED === 'true') result.cleanup = await cleanExpiredUploads();
    res.json(result);
  } catch { res.status(503).json({ message: 'Media worker temporarily unavailable' }); }
});
router.get('/media-download/:token', async (req, res) => {
  try {
    const ticket = await MediaDownloadTicket.findById(digest(req.params.token)).lean();
    if (!ticket || ticket.expiresAt < new Date()) return res.sendStatus(404);
    const [user, order, job] = await Promise.all([StaffUser.findById(ticket.staffId).lean(), Order.findById(ticket.orderId).lean(), MediaJob.findById(ticket.jobId).lean()]);
    if (!user?.isActive || user.deletedAt || !order || !['admin', 'manager', 'designer'].includes(user.role) || (user.role === 'designer' && String(order.assignedDesigner) !== String(user._id))) return res.sendStatus(403);
    if (job?.state !== 'ready') return res.sendStatus(409);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${photoArchiveFileName(order.trackingId || order.submissionId, job.folder)}"`);
    const stream = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'mediaArchives' }).openDownloadStream(new mongoose.Types.ObjectId(job.outputId));
    res.on('close', () => stream.destroy());
    await pipeline(stream, res);
  } catch (error) { if (res.headersSent) res.destroy(error); else res.sendStatus(500); }
});
export default router;
