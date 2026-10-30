import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { StaffUser } from '../models/StaffUser.model.js';

const COMPROMISED_FALLBACK_SECRETS = new Set([
  'tinzel-dev-jwt-secret-key-2026',
  'tinzel_enterprise_fallback_secret_2026',
  'secret',
  'changeme',
]);

// Ephemeral CSPRNG secret for isolated test/dev processes when JWT_SECRET is not set.
// Never uses a static known string so forged tokens with legacy fallback secrets always fail.
const EPHEMERAL_NON_PROD_SECRET = randomBytes(32).toString('hex');

export function getJwtSecret() {
  const configured = (process.env.JWT_SECRET || '').trim();
  if (configured) {
    if (COMPROMISED_FALLBACK_SECRETS.has(configured) || configured.length < 32) {
      throw new Error(
        'Refusing to use weak or known fallback JWT_SECRET. Configure a strong secret of at least 32 characters.'
      );
    }
    return configured;
  }

  if (process.env.NODE_ENV === 'production' || process.env.REQUIRE_JWT_SECRET === 'true') {
    throw new Error(
      'CRITICAL: JWT_SECRET environment variable is required in production (minimum 32 characters).'
    );
  }

  return EPHEMERAL_NON_PROD_SECRET;
}

if (process.env.NODE_ENV === 'production') {
  getJwtSecret();
}

export const generateToken = (user) => {
  return jwt.sign(
    { id: user._id, email: user.email, role: user.role, name: user.name },
    getJwtSecret(),
    { expiresIn: '7d' }
  );
};

export const generateClientToken = (order) => {
  return jwt.sign(
    { orderId: order._id, trackingId: order.trackingId, clientWhatsApp: order.clientWhatsApp, role: 'client' },
    getJwtSecret(),
    { expiresIn: '24h' }
  );
};

export const verifyStaffToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Authorization token required' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, getJwtSecret());

    const user = await StaffUser.findById(decoded.id).select('-passwordHash');
    if (!user || !user.isActive || user.deletedAt) {
      return res.status(401).json({ success: false, message: 'Invalid or inactive user account' });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

export const requireRoles = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Forbidden: requires one of the following roles: ${roles.join(', ')}`,
      });
    }
    next();
  };
};

export const verifyClientToken = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Client authorization token required' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, getJwtSecret());

    if (decoded.role !== 'client' || !decoded.orderId) {
      return res.status(401).json({ success: false, message: 'Invalid client token' });
    }

    req.clientAuth = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid or expired client session' });
  }
};
