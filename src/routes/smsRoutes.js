import { Router } from 'express';
import { sendSmsNotification, checkSmsHealth } from '../controllers/smsController.js';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: SMS
 *   description: Transactional SMS order notifications via NextSMS API
 */

/**
 * @swagger
 * /api/v1/sms/health:
 *   get:
 *     summary: Check NextSMS gateway health and SMS credit balance
 *     tags: [SMS]
 *     responses:
 *       200:
 *         description: NextSMS gateway is reachable and authenticated
 */
router.get('/health', checkSmsHealth);

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
 *                 example: "+255762022730"
 *               message:
 *                 type: string
 *                 description: Transactional SMS message content
 *                 example: "Hello! Your Tinzel order #TNZ-2026-001 status has been updated to Ready."
 *               from:
 *                 type: string
 *                 description: Optional registered Sender ID override (defaults to NEXTSMS_SENDER_ID or NEXTSMS)
 *                 example: "NEXTSMS"
 *     responses:
 *       200:
 *         description: SMS dispatched successfully via NextSMS
 *       400:
 *         description: Missing or invalid phone number or message body
 *       422:
 *         description: Request authenticated, but NextSMS rejected the payload (e.g. unregistered Sender ID)
 *       500:
 *         description: Server configuration error (e.g. missing NEXTSMS credentials)
 *       502:
 *         description: Upstream NextSMS gateway error
 */
router.post('/send', sendSmsNotification);

export default router;
