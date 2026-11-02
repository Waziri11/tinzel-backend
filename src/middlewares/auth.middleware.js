import {recordSecurityEvent} from '../services/securityAuditService.js';
import {roleAllowed} from '../services/authorizationService.js';
import {createSession,readSession,contactFingerprint,digest} from '../services/accessSessionService.js';
import {Order} from '../models/Order.model.js';
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

  if (process.env.REQUIRE_JWT_SECRET === 'true' || process.env.NODE_ENV === 'production') {
    throw new Error(
      'CRITICAL: JWT_SECRET environment variable is required in production (minimum 32 characters).'
    );
  }

  return EPHEMERAL_SECRET;
}

if (process.env.REQUIRE_JWT_SECRET === 'true' || process.env.NODE_ENV === 'production') {
  getJwtSecret();
}

export const generateToken = (user,options) => createSession('staff',user,options);
export const generateClientToken = order => createSession('client',order);

export const verifyStaffToken = async (req, res, next) => {
  const deny=async(status,body)=>{
    if(/\/download\//.test(req.path))await recordSecurityEvent(req,{action:'DOWNLOAD_DENIED',outcome:'denied'});
    return res.status(status).json(body);
  };
  try {
    const session = await readSession(req,'staff');
    const decoded={id:session.subjectId,tv:session.tokenVersion,purpose:session.purpose};
    const user = await StaffUser.findById(decoded.id).select('-passwordHash');
    req.auditActor=user;
    if (!user || !user.isActive || user.deletedAt) {
      return await deny(401,{ success: false, message: 'Invalid or inactive user account' });
    }

    if (session.role!==user.role || session.contactFingerprint!==contactFingerprint(user) || Number(decoded.tv ?? 0) !== Number(user.tokenVersion ?? 0)) {
      return await deny(401,{ success: false, message: 'Session has been revoked. Please sign in again.' });
    }

    if(decoded.purpose==='password_setup' && !user.mustChangePassword)return await deny(401,{message:'Your setup session has ended. Please sign in again.'});
    if(user.mustChangePassword) {
      if(!user.temporaryPasswordExpiresAt || new Date(user.temporaryPasswordExpiresAt)<=new Date())return await deny(401,{errorCode:'INITIAL_PASSWORD_EXPIRED',message:'Your initial password has expired. Ask an administrator to issue a new one.'});
      const allowed=new Set(['/api/staff/me','/api/staff/preferences','/api/staff/change-password','/api/staff/logout']);
      if(!allowed.has(req.originalUrl.split('?')[0]))return await deny(403,{errorCode:'PASSWORD_CHANGE_REQUIRED',message:'Change your initial password before continuing.'});
    }
    if(['admin','manager'].includes(user.role) && !user.mustChangePassword && !session.verifiedAt && !req.originalUrl.startsWith('/api/staff/step-up') && !req.originalUrl.startsWith('/api/staff/me') && !req.originalUrl.startsWith('/api/staff/logout'))return await deny(403,{errorCode:'OTP_REQUIRED',message:'Verify your identity before continuing'});
    req.user = user;
    next();
  } catch (error) {
    return await deny(error.status || 500,{ success: false, message: error.message || 'Authentication error' });
  }
};

export const requireRoles = (...roles) => {
  return async (req, res, next) => {
    if (!roleAllowed(req.user,roles)) {
      await recordSecurityEvent(req,{action:'AUTHORIZATION_DENIED',outcome:'denied'});
      return res.status(403).json({
        success: false,
        message: `Forbidden: requires one of the following roles: ${roles.join(', ')}`,
      });
    }
    next();
  };
};

export const verifyClientToken = async (req,res,next) => {
 try{const session=await readSession(req,'client');const order=await Order.findById(session.subjectId).select('_id trackingId clientWhatsApp');
 if(!order || session.contactFingerprint!==digest(`${order.trackingId}|${order.clientWhatsApp}`))throw new Error('Order session unavailable');req.clientAuth={orderId:order._id,trackingId:order.trackingId,role:'client'};next();
 }catch(error){res.status(error.status||401).json({message:error.message||'Client session expired'});}
};
