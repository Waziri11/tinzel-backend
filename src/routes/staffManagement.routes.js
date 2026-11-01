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
import { importGoogleForm, GoogleFormsImportError } from '../services/googleFormsImportService.js';

import { uploadCover } from '../services/uploadService.js';
import { storeCoverImage } from '../services/coverStorageService.js';

const router = Router();
router.use(verifyStaffToken, requireRoles('admin','manager'));
router.use('/staff', (req,res,next) => {
  if (req.user.role !== 'manager') return next();
  if (req.method === 'DELETE') return res.status(403).json({message:'Managers cannot delete accounts.'});
  if (req.body?.role !== undefined && req.body.role !== 'designer') return res.status(403).json({message:'Managers can manage designers only.'});
  if (req.method === 'POST' && req.path === '/' && !req.body.role) req.body.role='designer';
  next();
});
router.use('/staff/:id', async (req,res,next) => {
  if (req.user.role !== 'manager') return next();
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({message:'Designer not found.'});
  try {
    const user=await StaffUser.findOne({_id:req.params.id,role:'designer',deletedAt:null}).select('_id');
    if (!user) return res.status(404).json({message:'Designer not found.'});
    next();
  } catch {res.status(500).json({message:'Unable to load designer.'});}
});
// --- Staff Management & Workload Endpoints ---
const staffRoles = ['admin', 'manager', 'designer'];
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
    const staff = await StaffUser.find({ deletedAt: null, ...(req.user.role === 'manager' ? {role:'designer'} : {}) }).select('-passwordHash').sort({ role: 1, name: 1 });
    return res.status(200).json({ success: true, staff: staff.map(publicStaff) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/staff/:id', async (req, res) => {
  try {
    const user = await StaffUser.findOne({ _id: req.params.id, deletedAt: null }).select('-passwordHash');
    if (!user) return res.status(404).json({ success: false, message: 'Staff user not found' });
    return res.status(200).json({ success: true, user: publicStaff(user) });
  } catch (error) {
    if (error.name === 'CastError') return res.status(404).json({ success: false, message: 'Staff user not found' });
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/staff', async (req, res) => {
  try {
    const { name, email, password, role, phone, maxActiveWorkload, isEligibleForAssignment } = req.body;
    if (typeof name !== 'string' || !name.trim() || typeof email !== 'string' || !emailPattern.test(email.trim()) || !validStaffPhone(phone)) {
      return res.status(400).json({ success: false, message: 'Name, valid email, and a valid phone number are required' });
    }
    if (!staffRoles.includes(role)) return res.status(400).json({ success: false, message: 'Choose a valid internal role' });
    if (role === 'designer' && maxActiveWorkload !== undefined && (!Number.isInteger(Number(maxActiveWorkload)) || Number(maxActiveWorkload) < 1 || Number(maxActiveWorkload) > 20)) {
      return res.status(400).json({ success: false, message: 'Designer capacity must be between 1 and 20' });
    }

    const existing = await StaffUser.findOne({ email: email.trim().toLowerCase() });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Email already registered' });
    }

    if (req.body.preferredLanguage !== undefined && !['en','sw'].includes(req.body.preferredLanguage)) return res.status(400).json({message:'Choose English or Kiswahili'});
    if (password !== undefined) return res.status(400).json({message:'Initial passwords are generated automatically.'});
    const staffId = new mongoose.Types.ObjectId();
    const credentials = await initialCredentialFields(staffId);

    const user = await StaffUser.create({
      preferredLanguage: req.body.preferredLanguage || 'sw',
      name: name.trim(),
      email: email.trim().toLowerCase(),
      _id: staffId,
      ...credentials,
      role,
      phone: typeof phone === 'string' ? phone.trim() : '',
      maxActiveWorkload: role === 'designer' && maxActiveWorkload !== undefined ? Number(maxActiveWorkload) : 5,
      isEligibleForAssignment: isEligibleForAssignment !== false,
    });

    await logStaffChange(req, 'STAFF_CREATED', user);
    await kickStaffCredentials(user._id);
    const savedUser = await StaffUser.findById(user._id).select('-passwordHash');
    return res.status(201).json({
      success: true,
      message: 'Staff account created successfully',
      user: publicStaff(savedUser),
    });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ success: false, message: 'Email already registered' });
    return res.status(error.status || 500).json({ success: false, message: error.message, errorCode:error.code });
  }
});

router.post('/staff/:id/initial-password',async(req,res)=>{
  try {const user=await reissueInitialPassword(req.params.id);await logStaffChange(req,'STAFF_INITIAL_PASSWORD_REISSUED',user);res.json({success:true,user:publicStaff(user)});}
  catch(error){res.status(error.name==='CastError'?404:error.status || 500).json({message:error.message,errorCode:error.code});}
});
router.post('/staff/:id/credential-delivery/retry',async(req,res)=>{
  try{await retryStaffCredentials(req.params.id,req.body.channel,{confirmUncertain:req.body.confirmUncertain===true});const user=await StaffUser.findById(req.params.id);res.json({success:true,user:publicStaff(user)});}
  catch(error){res.status(error.name==='CastError'?404:error.status || 500).json({message:error.message});}
});

router.put('/staff/:id', async (req, res) => {
  try {
    const user = await StaffUser.findOne({ _id: req.params.id, deletedAt: null });
    if (!user) return res.status(404).json({ success: false, message: 'Staff user not found' });
    if (req.body.preferredLanguage !== undefined) {
      if (!['en','sw'].includes(req.body.preferredLanguage)) return res.status(400).json({message:'Choose English or Kiswahili'});
      user.preferredLanguage = req.body.preferredLanguage;
    }
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
    if (password !== undefined) return res.status(400).json({message:'Use Issue new initial password to reset access.'});
    if (!user.isActive || user.deletedAt) user.credentialJob=null;
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
    if(!user.isActive)await finishStaffCredentialDelivery(user._id,user.credentialGeneration || 0).catch(()=>{});
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
    user.credentialJob = null;
    user.deletedAt = new Date();
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    await finishStaffCredentialDelivery(user._id,user.credentialGeneration || 0).catch(()=>{});
    await logStaffChange(req, 'STAFF_DELETED', user);
    return res.status(200).json({ success: true, message: 'Staff account deleted' });
  } catch (error) {
    if (error.name === 'CastError') return res.status(404).json({ success: false, message: 'Staff user not found' });
    return res.status(500).json({ success: false, message: error.message });
  }
});


export default router;
