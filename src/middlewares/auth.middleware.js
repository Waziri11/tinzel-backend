import jwt from 'jsonwebtoken';
import { createHmac, randomBytes } from 'node:crypto';
import { StaffUser } from '../models/StaffUser.model.js';

const COMPROMISED_FALLBACK_SECRETS = new Set([
  'tinzel-dev-jwt-secret-key-2026',
  'tinzel_enterprise_fallback_secret_2026',
  'secret',
  'changeme',
]);

// Ephemeral CSPRNG secret for runtime instances when JWT_SECRET is not explicitly set in the environment.
// Generated securely at process launch so forged tokens with legacy static fallback secrets always fail.
const EPHEMERAL_SECRET = randomBytes(32).toString('hex');
let warnedAboutMissingSecret = false;

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

  if (process.env.REQUIRE_JWT_SECRET === 'true') {
    throw new Error(
      'CRITICAL: JWT_SECRET environment variable is required in production (minimum 32 characters).'
    );
  }

  // In multi-instance or serverless environments (like Vercel) where JWT_SECRET has not yet
  // been explicitly configured in project env vars, derive a consistent 256-bit secret
  // from the private MONGODB_URI so all serverless cold starts share the exact same verification key.
  const mongoUri = (process.env.MONGODB_URI || '').trim();
  if (mongoUri) {
    return createHmac('sha256', 'tinzel-jwt-stable-cluster-salt-2026')
      .update(mongoUri)
      .digest('hex');
  }

  if (process.env.NODE_ENV === 'production' && !warnedAboutMissingSecret) {
    warnedAboutMissingSecret = true;
    console.warn(
      '[Security Warning] Neither JWT_SECRET nor MONGODB_URI is available. Using ephemeral secret.'
    );
  }

  return EPHEMERAL_SECRET;
}

if (process.env.REQUIRE_JWT_SECRET === 'true') {
  getJwtSecret();
}

export const generateToken = (user) => {
  return jwt.sign(
    {
      id: user._id,
      email: user.email,
      role: user.role,
      name: user.name,
      tv: Number(user.tokenVersion || 0),
    },
    getJwtSecret(),
    { expiresIn: process.env.STAFF_JWT_EXPIRES_IN || '12h' }
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
    let decoded;
    try {
      decoded = jwt.verify(token, getJwtSecret());
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }

    const user = await StaffUser.findById(decoded.id).select('-passwordHash');
    if (!user || !user.isActive || user.deletedAt) {
      return res.status(401).json({ success: false, message: 'Invalid or inactive user account' });
    }

    if (Number(decoded.tv ?? 0) !== Number(user.tokenVersion ?? 0)) {
      return res.status(401).json({ success: false, message: 'Session has been revoked. Please sign in again.' });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Authentication error' });
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
