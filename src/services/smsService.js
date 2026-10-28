import dotenv from 'dotenv';

dotenv.config();

const NEXTSMS_V2_SINGLE_TEXT_ENDPOINT = 'https://messaging-service.co.tz/api/sms/v2/text/single';
const NEXTSMS_V1_SINGLE_TEXT_ENDPOINT = 'https://messaging-service.co.tz/api/sms/v1/text/single';
const NEXTSMS_V2_BALANCE_ENDPOINT = 'https://messaging-service.co.tz/api/v2/balance';
const DEFAULT_SENDER_ID = 'ORDER';

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
 * Checks whether NextSMS credentials (v2 API key or v1 username/password) are configured.
 */
export const isNextSMSConfigured = () => {
  return Boolean(
    process.env.NEXTSMS_API_KEY?.trim() ||
      (process.env.NEXTSMS_USERNAME?.trim() && process.env.NEXTSMS_PASSWORD?.trim())
  );
};

/**
 * Resolves the appropriate NextSMS endpoint and Authorization header.
 * - Uses NextSMS API v2 with Bearer token if `NEXTSMS_API_KEY` is set.
 * - Falls back to NextSMS API v1 with Basic Auth (Base64 username:password) otherwise.
 */
export const resolveNextSMSAuth = () => {
  const apiKey = process.env.NEXTSMS_API_KEY?.trim();
  const username = process.env.NEXTSMS_USERNAME?.trim();
  const password = process.env.NEXTSMS_PASSWORD?.trim();

  if (apiKey) {
    const cleanToken = apiKey.replace(/^(Bearer|Basic)\s+/i, '');
    return {
      version: 'v2',
      endpoint: NEXTSMS_V2_SINGLE_TEXT_ENDPOINT,
      authHeader: `Bearer ${cleanToken}`,
    };
  }

  if (username && password) {
    const basicAuthToken = Buffer.from(`${username}:${password}`).toString('base64');
    return {
      version: 'v1',
      endpoint: NEXTSMS_V1_SINGLE_TEXT_ENDPOINT,
      authHeader: `Basic ${basicAuthToken}`,
    };
  }

  const error = new Error(
    'NextSMS credentials are not configured. Please set NEXTSMS_API_KEY or both NEXTSMS_USERNAME and NEXTSMS_PASSWORD in the environment.'
  );
  error.status = 500;
  throw error;
};

/**
 * Sends a transactional single-text SMS via the NextSMS API.
 *
 * @param {string} to - Recipient phone number
 * @param {string} message - SMS text body
 * @param {string} [senderId] - Optional Sender ID override (defaults to NEXTSMS_SENDER_ID or 'NEXTSMS')
 * @returns {Promise<object>} Parsed response payload from NextSMS
 */
export const sendNextSMS = async (to, message, senderId) => {
  if (typeof message !== 'string' || !message.trim()) {
    const error = new Error('A non-empty SMS "message" is required.');
    error.status = 400;
    throw error;
  }

  const formattedPhone = formatTanzanianPhone(to);
  const { endpoint, authHeader } = resolveNextSMSAuth();
  const resolvedSender = (senderId || process.env.NEXTSMS_SENDER_ID || DEFAULT_SENDER_ID).trim();

  const payload = {
    from: resolvedSender,
    to: formattedPhone,
    text: message.trim(),
  };

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
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

/**
 * Queries the NextSMS v2 balance endpoint to verify account health & SMS credits.
 */
export const getNextSMSHealth = async () => {
  const senderId = (process.env.NEXTSMS_SENDER_ID || DEFAULT_SENDER_ID).trim();
  if (!isNextSMSConfigured()) {
    return {
      configured: false,
      authenticated: false,
      mode: 'simulated',
      apiVersion: null,
      configuredSenderId: senderId,
      httpStatus: 0,
      latencyMs: 0,
      balance: null,
      message: 'NextSMS credentials are not configured in environment.',
    };
  }

  const startedAt = Date.now();
  try {
    const { version, authHeader, endpoint } = resolveNextSMSAuth();
    const response = await fetch(NEXTSMS_V2_BALANCE_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
      },
    });

    const data = await response.json().catch(() => null);
    return {
      configured: true,
      authenticated: response.ok,
      mode: response.ok ? 'nextsms_live' : 'error',
      apiVersion: version,
      endpoint,
      configuredSenderId: senderId,
      httpStatus: response.status,
      latencyMs: Date.now() - startedAt,
      balance: data,
      message: response.ok
        ? `Connected to NextSMS API (${version}). Active Sender ID: ${senderId}.`
        : `NextSMS balance check returned HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      configured: true,
      authenticated: false,
      mode: 'error',
      apiVersion: 'v2',
      configuredSenderId: senderId,
      httpStatus: 502,
      latencyMs: Date.now() - startedAt,
      balance: null,
      message: `Failed to reach NextSMS API: ${error.message}`,
    };
  }
};
