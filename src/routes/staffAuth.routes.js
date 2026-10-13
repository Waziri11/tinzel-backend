import { Router } from 'express';
import { StaffUser } from '../models/StaffUser.model.js';
import { generateToken, verifyStaffToken } from '../middlewares/auth.middleware.js';

const router = Router();

// Staff Login
router.post('/login', async (req, res) => {
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

    if (!user.isActive) {
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
      currentActiveWorkload: req.user.currentActiveWorkload,
      maxActiveWorkload: req.user.maxActiveWorkload,
      isEligibleForAssignment: req.user.isEligibleForAssignment,
    },
  });
});

export default router;
