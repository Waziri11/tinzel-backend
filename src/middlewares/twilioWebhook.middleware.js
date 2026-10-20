import twilio from 'twilio';

/**
 * Middleware to validate incoming Twilio Webhook signatures.
 * In development or test environments, or if TWILIO_AUTH_TOKEN is not configured,
 * requests are allowed through with a log.
 */
export const verifyTwilioWebhook = (req, res, next) => {
  // Allow bypassing in tests or if explicitly disabled
  if (
    process.env.NODE_ENV === 'test' ||
    process.env.TWILIO_VALIDATE_WEBHOOKS === 'false' ||
    !process.env.TWILIO_AUTH_TOKEN
  ) {
    return next();
  }

  const twilioSignature = req.headers['x-twilio-signature'];
  if (!twilioSignature) {
    console.warn('[Twilio Webhook] Missing X-Twilio-Signature header');
    return res.status(403).send('Forbidden: Missing Twilio Signature');
  }

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const fullUrl = `${protocol}://${host}${req.originalUrl}`;

  const isValid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    twilioSignature,
    fullUrl,
    req.body || {}
  );

  if (!isValid) {
    console.warn(`[Twilio Webhook] Invalid signature for URL: ${fullUrl}`);
    return res.status(403).send('Forbidden: Invalid Twilio Signature');
  }

  next();
};
