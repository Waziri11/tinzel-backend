import mongoose from 'mongoose';
import { sendNextSMS, getNextSMSHealth } from '../services/smsService.js';
import { AuditLog } from '../models/AuditLog.model.js';

const MAX_SMS_MESSAGE_LENGTH = 480;

/**
 * Controller to trigger a transactional SMS notification via NextSMS.
 * Expects `{ to, message, from? }` in `req.body`.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export const sendSmsNotification = async (req, res, next) => {
  try {
    const { to, message, from } = req.body || {};

    if (!to || typeof to !== 'string' || !to.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Recipient phone number ("to") is required.',
      });
    }

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        success: false,
        message: 'SMS text content ("message") is required.',
      });
    }

    if (message.trim().length > MAX_SMS_MESSAGE_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `SMS text content must not exceed ${MAX_SMS_MESSAGE_LENGTH} characters.`,
      });
    }

    const result = await sendNextSMS(to, message.trim(), from);

    const firstStatus = result?.messages?.[0]?.status;
    const isRejected = firstStatus?.groupName === 'REJECTED';

    if (mongoose.connection.readyState === 1) {
      await AuditLog.create({
        actor: {
          type: req.user?.role || 'system',
          id: req.user?._id,
          name: req.user?.name || 'System',
        },
        action: 'SMS_DISPATCHED',
        details: {
          to: firstStatus?.to || to.trim(),
          messageLength: message.trim().length,
          rejected: isRejected,
        },
        ipAddress: req.ip,
      }).catch(() => {});
    }

    return res.status(isRejected ? 422 : 200).json({
      success: !isRejected,
      message: isRejected
        ? `NextSMS rejected the message: ${firstStatus.description || firstStatus.name}`
        : 'SMS sent successfully',
      data: result,
    });
  } catch (error) {
    const statusCode = error.status || 500;
    if (statusCode >= 400 && statusCode < 600) {
      return res.status(statusCode).json({
        success: false,
        message: error.message || 'Failed to send SMS',
        ...(error.details ? { details: error.details } : {}),
      });
    }
    return next(error);
  }
};

/**
 * Controller to check NextSMS API health, authentication status, and SMS balance.
 */
export const checkSmsHealth = async (_req, res) => {
  try {
    const health = await getNextSMSHealth();
    return res.status(health.authenticated ? 200 : 502).json({
      success: health.authenticated,
      ...health,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to check NextSMS health',
    });
  }
};
