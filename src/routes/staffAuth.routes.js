import bcrypt from 'bcryptjs';
import { passwordErrors, finishStaffCredentialDelivery } from '../services/staffCredentialService.js';
import { AuditLog } from '../models/AuditLog.model.js';
import { Router } from 'express';
import { StaffUser } from '../models/StaffUser.model.js';
import { generateToken, verifyStaffToken } from '../middlewares/auth.middleware.js';
import { createRateLimiter } from '../middlewares/rateLimiter.js';

const router = Router();

const loginRateLimiter = createRateLimiter({
  scope: 'staff-login',
  maxAttempts: 10,
  windowMs: 15 * 60 * 1000,
  keyGenerator: (req) => `${req.ip || 'ip'}:${String(req.body?.email || '').trim().toLowerCase()}`,
  message: 'Too many login attempts. Please wait 15 minutes before trying again.',
});

// Staff Login
router.post('/login', loginRateLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (typeof email!=='string' || typeof password!=='string' || !email.trim() || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const user = await StaffUser.findOne({ email: email.trim().toLowerCase() });
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    if (!user.isActive || user.deletedAt) {
      return res.status(403).json({ success: false, message: 'Account is deactivated' });
    }

    if(user.mustChangePassword && (!user.temporaryPasswordExpiresAt || user.temporaryPasswordExpiresAt<=new Date()))return res.status(401).json({errorCode:'INITIAL_PASSWORD_EXPIRED',message:'Your initial password has expired. Ask an administrator to issue a new one.'});
    const token = generateToken(user);

    return res.status(200).json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        preferredLanguage: user.preferredLanguage || 'sw',
        mustChangePassword:Boolean(user.mustChangePassword),
        temporaryPasswordExpiresAt:user.temporaryPasswordExpiresAt || null,
        currentActiveWorkload: user.currentActiveWorkload,
        maxActiveWorkload: user.maxActiveWorkload,
        isEligibleForAssignment: user.isEligibleForAssignment,
      },
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message, errorCode:error.code });
  }
});

// Current User Profile
router.get('/me', verifyStaffToken, async (req, res) => {
  return res.status(200).json({
    success: true,
    user: {
      id: req.user._id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      preferredLanguage: req.user.preferredLanguage || 'sw',
      mustChangePassword:Boolean(req.user.mustChangePassword),
      temporaryPasswordExpiresAt:req.user.temporaryPasswordExpiresAt || null,
      currentActiveWorkload: req.user.currentActiveWorkload,
      maxActiveWorkload: req.user.maxActiveWorkload,
      isEligibleForAssignment: req.user.isEligibleForAssignment,
    },
  });
});

router.patch('/preferences', verifyStaffToken, async (req,res)=>{
  if (!['en','sw'].includes(req.body.preferredLanguage)) return res.status(400).json({message:'Choose English or Kiswahili'});
  await StaffUser.updateOne({_id:req.user._id},{$set:{preferredLanguage:req.body.preferredLanguage}});
  return res.json({success:true,preferredLanguage:req.body.preferredLanguage});
});

const changeLimiter=createRateLimiter({scope:'staff-password-change',maxAttempts:10,windowMs:15*60*1000,keyGenerator:req=>String(req.user._id),message:'Too many password change attempts. Please try again later.'});
router.post('/change-password',verifyStaffToken,changeLimiter,async(req,res)=>{
  try{
    const {currentPassword,newPassword}=req.body;
    const errors=passwordErrors(newPassword);
    if(typeof currentPassword!=='string'||!currentPassword)return res.status(400).json({message:'Current password is required.'});
    if(errors.length)return res.status(400).json({message:'Password does not meet requirements.',errors});
    const user=await StaffUser.findById(req.user._id);
    if(!user || !await user.comparePassword(currentPassword))return res.status(400).json({message:'Current password is incorrect.'});
    if(await user.comparePassword(newPassword))return res.status(400).json({message:'Choose a different password from your current password.'});
    if(user.mustChangePassword && user.temporaryPasswordExpiresAt<=new Date())return res.status(401).json({errorCode:'INITIAL_PASSWORD_EXPIRED',message:'Your initial password has expired. Ask an administrator to issue a new one.'});
    const hash=await bcrypt.hash(newPassword,10);
    const updated=await StaffUser.findOneAndUpdate({_id:user._id,isActive:true,deletedAt:null,passwordHash:user.passwordHash,tokenVersion:{$in:[user.tokenVersion || 0,...(!user.tokenVersion?[null]:[])]},credentialGeneration:{$in:[user.credentialGeneration || 0,...(!user.credentialGeneration?[null]:[])]},...(user.mustChangePassword?{temporaryPasswordExpiresAt:{$gt:new Date()}}:{})},{$set:{passwordHash:hash,mustChangePassword:false,temporaryPasswordExpiresAt:null,passwordChangedAt:new Date()},$unset:{credentialJob:1},$inc:{tokenVersion:1}},{returnDocument:'after'});
    if(!updated){if(user.mustChangePassword&&user.temporaryPasswordExpiresAt<=new Date())return res.status(401).json({errorCode:'INITIAL_PASSWORD_EXPIRED',message:'Your initial password has expired. Ask an administrator to issue a new one.'});return res.status(409).json({message:'Your account changed. Please sign in again before changing the password.'});}
    await finishStaffCredentialDelivery(updated._id,updated.credentialGeneration || 0).catch(()=>{});
    await AuditLog.create({actor:{type:updated.role,id:updated._id,name:updated.name},action:'STAFF_PASSWORD_CHANGED',details:{staffId:updated._id}});
    return res.json({success:true,token:generateToken(updated),user:{id:updated._id,name:updated.name,email:updated.email,role:updated.role,preferredLanguage:updated.preferredLanguage || 'sw',mustChangePassword:false,currentActiveWorkload:updated.currentActiveWorkload,maxActiveWorkload:updated.maxActiveWorkload,isEligibleForAssignment:updated.isEligibleForAssignment}});
  }catch{res.status(500).json({message:'Unable to change the password. Please retry.'});}
});

// Revoke Active Staff Session Tokens on Logout
router.post('/logout', verifyStaffToken, async (req, res) => {
  try {
    await StaffUser.findByIdAndUpdate(req.user._id, { $inc: { tokenVersion: 1 } });
    return res.status(200).json({
      success: true,
      message: 'Logged out and active session tokens revoked',
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to revoke session' });
  }
});

export default router;
