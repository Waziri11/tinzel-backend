import { requirePhone } from '../utils/phone.js';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { ProviderConfig } from '../models/ProviderConfig.model.js';
export const PROVIDER_FIELDS = {
  nextsms: {
    NEXTSMS_AUTH_MODE: false,
    NEXTSMS_API_KEY: true,
    NEXTSMS_USERNAME: false,
    NEXTSMS_PASSWORD: true,
    NEXTSMS_SENDER_ID: false,
  },
  smtp: {
    SMTP_HOST: false,
    SMTP_PORT: false,
    SMTP_SECURE: false,
    SMTP_USER: false,
    SMTP_PASS: true,
    SMTP_FROM: false,
  },
  twilio: {
    TWILIO_ACCOUNT_SID: false,
    TWILIO_AUTH_TOKEN: true,
    TWILIO_PHONE_NUMBER: false,
    TWILIO_WHATSAPP_NUMBER: false,
    TWILIO_STATUS_CALLBACK_URL: false,
    ENABLE_TWILIO_SMS_FALLBACK: false,
  },
};
function key() {
  const raw = process.env.PROVIDER_CONFIG_ENCRYPTION_KEY || '';
  if (
    !/^[A-Za-z0-9+/]{43}=$/.test(raw) ||
    Buffer.from(raw, 'base64').length !== 32
  )
    throw Object.assign(
      new Error(
        'Provider encryption is not configured. Configure PROVIDER_CONFIG_ENCRYPTION_KEY in deployment settings.',
      ),
      { status: 503 },
    );
  return Buffer.from(raw, 'base64');
}
export function encryptProviderSecret(value, field) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(field));
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    data: data.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}
export function decryptProviderSecret(payload, field) {
  try {
    const cipher = createDecipheriv(
      'aes-256-gcm',
      key(),
      Buffer.from(payload.iv, 'base64'),
    );
    cipher.setAAD(Buffer.from(field));
    cipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    return Buffer.concat([
      cipher.update(Buffer.from(payload.data, 'base64')),
      cipher.final(),
    ]).toString('utf8');
  } catch {
    throw Object.assign(
      new Error(
        'Provider settings cannot be decrypted. Check the deployment encryption key.',
      ),
      { status: 503 },
    );
  }
}
let overrides = {},
  expires = 0,
  pending,
  generation = 0;
export function invalidateProviderSettings() {
  generation++;
  expires = 0;
  overrides = {};
}
export async function refreshProviderSettings(force = false) {
  if (!force && Date.now() < expires) return;
  if (pending) {
    await pending;
    return refreshProviderSettings(force);
  }
  const version = generation;
  pending = (async () => {
    if (mongoose.connection.readyState !== 1) {
      if (process.env.NODE_ENV === 'production')
        throw new Error('Provider settings unavailable.');
      overrides = {};
      return;
    }
    const rows = await ProviderConfig.find().select('+secrets').lean(),
      next = {};
    for (const row of rows) {
      Object.assign(next, row.values);
      for (const [field, payload] of Object.entries(row.secrets || {}))
        next[field] = decryptProviderSecret(payload, field);
    }
    if (version === generation) {
      overrides = next;
      expires = Date.now() + 5000;
    }
  })();
  try {
    await pending;
  } finally {
    pending = null;
  }
  if (version !== generation) return refreshProviderSettings(force);
}
export function providerOverride(field) {
  return Object.hasOwn(overrides, field) ? overrides[field] : undefined;
}
export function providerValue(field) {
  return Object.prototype.hasOwnProperty.call(overrides, field)
    ? overrides[field]
    : process.env[field];
}
export function validateProviderValue(field, value) {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    /[\r\n\0]/.test(value)
  )
    throw Object.assign(new Error('Invalid provider setting.'), {
      status: 400,
    });
  const v = value.trim();
  if (
    field === 'NEXTSMS_AUTH_MODE' &&
    !['auto', 'api_key', 'basic'].includes(v)
  )
    throw Object.assign(
      new Error('Choose auto, api_key or basic authentication.'),
      { status: 400 },
    );
  if (
    field === 'SMTP_PORT' &&
    (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 65535)
  )
    throw Object.assign(new Error('SMTP port must be between 1 and 65535.'), {
      status: 400,
    });
  if (
    ['SMTP_SECURE', 'ENABLE_TWILIO_SMS_FALLBACK'].includes(field) &&
    !['true', 'false'].includes(v)
  )
    throw Object.assign(new Error('Choose true or false.'), { status: 400 });
  if (field === 'SMTP_HOST' && !/^[a-zA-Z0-9.-]+$/.test(v))
    throw Object.assign(new Error('Enter a valid SMTP hostname.'), {
      status: 400,
    });
  if (field.endsWith('_PHONE_NUMBER') || field === 'TWILIO_WHATSAPP_NUMBER') return requirePhone(v.replace(/^whatsapp:/i, ''));
  if (field === 'TWILIO_STATUS_CALLBACK_URL') {
    let url;
    try {
      url = new URL(v);
    } catch {}
    if (!url || url.protocol !== 'https:' || url.username || url.password)
      throw Object.assign(new Error('Use an HTTPS callback URL.'), {
        status: 400,
      });
  }
  return v;
}
export async function providerMetadata() {
  const rows = await ProviderConfig.find().select('+secrets').lean();
  return Object.entries(PROVIDER_FIELDS).map(([provider, fields]) => {
    const row = rows.find((x) => x.provider === provider);
    return {
      provider,
      revision: row?.__v ?? null,
      updatedAt: row?.updatedAt || null,
      fields: Object.entries(fields).map(([name, secret]) => {
        const override = secret
          ? !!row?.secrets?.[name]
          : Object.hasOwn(row?.values || {}, name);
        return {
          name,
          secret,
          configured: override || Boolean(process.env[name]),
          source: override
            ? 'saved'
            : process.env[name]
              ? 'environment'
              : 'unset',
          ...(!secret
            ? { value: override ? row.values[name] : process.env[name] || '' }
            : {}),
        };
      }),
    };
  });
}

export function redactProviderText(value) {
  let text = String(value ?? '');
  for (const fields of Object.values(PROVIDER_FIELDS))
    for (const [field, secret] of Object.entries(fields))
      if (secret) {
        const raw = providerValue(field);
        if (raw) text = text.split(raw).join('[REDACTED]');
      }
  const username = providerValue('NEXTSMS_USERNAME'),
    password = providerValue('NEXTSMS_PASSWORD');
  if (username && password)
    text = text
      .split(Buffer.from(`${username}:${password}`).toString('base64'))
      .join('[REDACTED]');
  return text.replace(
    /(Bearer|Basic)\s+[A-Za-z0-9+\/_=.-]+/gi,
    '$1 [REDACTED]',
  );
}
export function redactProviderDiagnostics(value) {
  if (typeof value === 'string') return redactProviderText(value);
  if (Array.isArray(value)) return value.map(redactProviderDiagnostics);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /password|token|authorization|api.?key/i.test(k)
          ? '[REDACTED]'
          : redactProviderDiagnostics(v),
      ]),
    );
  return value;
}
