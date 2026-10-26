import { sendNextSMS } from '../services/smsService.js';

/**
 * Controller to trigger a transactional SMS notification via NextSMS.
 * Expects `{ to, message }` in `req.body`.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export const sendSmsNotification = async (req, res, next) => {
  try {
    const { to, message } = req.body || {};

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

    const result = await sendNextSMS(to, message);

    return res.status(200).json({
      success: true,
      message: 'SMS sent successfully',
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
