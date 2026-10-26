import { Router } from 'express';
import { sendSmsNotification } from '../controllers/smsController.js';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: SMS
 *   description: Transactional SMS order notifications via NextSMS API
 */

/**
 * @swagger
 * /api/v1/sms/send:
 *   post:
 *     summary: Send a transactional SMS notification via NextSMS
 *     description: >
 *       Sends a single transactional SMS message (e.g., when an order status is updated to "Ready").
 *       Automatically formats Tanzanian phone numbers to start with `255` without a leading `+`.
 *     tags: [SMS]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - to
 *               - message
 *             properties:
 *               to:
 *                 type: string
 *                 description: Recipient phone number in Tanzanian format (+255..., 255..., or 07...)
 *                 example: "+255712345678"
 *               message:
 *                 type: string
 *                 description: Transactional SMS message content
 *                 example: "Hello! Your Tinzel order #TNZ-2026-001 status has been updated to Ready."
 *     responses:
 *       200:
 *         description: SMS dispatched successfully via NextSMS
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "SMS sent successfully"
 *                 data:
 *                   type: object
 *                   description: Raw response returned by NextSMS API
 *       400:
 *         description: Missing or invalid phone number or message body
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Recipient phone number (\"to\") is required."
 *       500:
 *         description: Server configuration error (e.g. missing NEXTSMS credentials)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "NextSMS credentials are not configured. Please set NEXTSMS_USERNAME and NEXTSMS_PASSWORD in the environment."
 *       502:
 *         description: Upstream NextSMS gateway error
 */
router.post('/send', sendSmsNotification);

export default router;
