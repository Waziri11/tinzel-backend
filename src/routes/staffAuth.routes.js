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
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const user = await StaffUser.findOne({ email: email.toLowerCase() });
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
        currentActiveWorkload: user.currentActiveWorkload,
        maxActiveWorkload: user.maxActiveWorkload,
        isEligibleForAssignment: user.isEligibleForAssignment,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
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
