import dotenv from 'dotenv';

dotenv.config();

const NEXTSMS_SINGLE_TEXT_ENDPOINT = 'https://messaging-service.co.tz/api/sms/v1/text/single';
const NEXTSMS_SENDER_ID = 'NEXTSMS';

/**
 * Formats a phone number to NextSMS Tanzanian format (starts with '255', no '+' sign).
 * Supports inputs like '+255712345678', '255712345678', '0712345678', or '712345678'.
 *
 * @param {string} phone - Raw phone number input
 * @returns {string} Formatted Tanzanian phone number starting with '255'
 */
export const formatTanzanianPhone = (phone) => {
  if (typeof phone !== 'string' || !phone.trim()) {
    const error = new Error('A valid recipient phone number ("to") is required.');
    error.status = 400;
    throw error;
  }

  // Remove '+' signs, spaces, hyphens, parentheses, and dots
  let cleaned = phone.trim().replace(/[+\s\-().]/g, '');

  // Convert local Tanzanian format starting with '0' (e.g. 0712345678 -> 255712345678)
  if (cleaned.startsWith('0')) {
    cleaned = `255${cleaned.slice(1)}`;
  } else if (!cleaned.startsWith('255') && /^\d{9}$/.test(cleaned)) {
    // Convert 9-digit local subscriber number (e.g. 712345678 -> 255712345678)
    cleaned = `255${cleaned}`;
  }

  if (!/^255\d{9}$/.test(cleaned)) {
    const error = new Error(
      'Invalid Tanzanian phone number format. Expected a number starting with 255 (e.g., 255712345678 or 0712345678).'
    );
    error.status = 400;
    throw error;
  }

  return cleaned;
};

/**
 * Sends a transactional single-text SMS via the NextSMS API.
 *
 * @param {string} to - Recipient phone number
 * @param {string} message - SMS text body
 * @returns {Promise<object>} Parsed response payload from NextSMS
 */
export const sendNextSMS = async (to, message) => {
  if (typeof message !== 'string' || !message.trim()) {
    const error = new Error('A non-empty SMS "message" is required.');
    error.status = 400;
    throw error;
  }

  const formattedPhone = formatTanzanianPhone(to);

  const apiKey = process.env.NEXTSMS_API_KEY?.trim();
  const username = process.env.NEXTSMS_USERNAME?.trim();
  const password = process.env.NEXTSMS_PASSWORD?.trim();

  let basicAuthToken;
  if (apiKey) {
    // Support either raw Base64 ("dXNlcjpwYXNz") or prefixed ("Basic dXNlcjpwYXNz")
    basicAuthToken = apiKey.replace(/^Basic\s+/i, '');
  } else if (username && password) {
    basicAuthToken = Buffer.from(`${username}:${password}`).toString('base64');
  } else {
    const error = new Error(
      'NextSMS credentials are not configured. Please set NEXTSMS_API_KEY or both NEXTSMS_USERNAME and NEXTSMS_PASSWORD in the environment.'
    );
    error.status = 500;
    throw error;
  }

  const payload = {
    from: NEXTSMS_SENDER_ID,
    to: formattedPhone,
    text: message.trim(),
  };

  let response;
  try {
    response = await fetch(NEXTSMS_SINGLE_TEXT_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuthToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (networkError) {
    const error = new Error(`Failed to reach NextSMS API: ${networkError.message}`);
    error.status = 502;
    error.cause = networkError;
    throw error;
  }

  const rawBody = await response.text();
  let parsedBody = null;
  if (rawBody) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = { raw: rawBody };
    }
  }

  if (!response.ok) {
    const upstreamMessage =
      parsedBody?.message ||
      parsedBody?.error ||
      parsedBody?.requestError?.serviceException?.text ||
      response.statusText ||
      'Unknown NextSMS API error';
    const error = new Error(`NextSMS API error (${response.status}): ${upstreamMessage}`);
    error.status = response.status >= 400 && response.status < 500 ? response.status : 502;
    error.details = parsedBody;
    throw error;
  }

  return parsedBody;
};
