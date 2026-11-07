import { notificationFrontendUrl } from './notificationUrls.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function messageContent(title, body, lang, actionUrl, actionLabel) {
  const label = actionLabel || (lang === 'sw' ? 'Fungua Tinzel' : 'Open Tinzel');
  const link = actionUrl ? `<p><a href="${escape(actionUrl)}">${escape(label)}</a></p>` : '';
  return {
    title,
    message: [body, actionUrl].filter(Boolean).join('\n'),
    html: `<html lang="${lang}"><body><h2>${escape(title)}</h2><p>${escape(body).replaceAll('\n', '<br>')}</p>${link}</body></html>`,
  };
}

export function staffCredentialMessage(user, password, channel) {
  const sw = user.preferredLanguage !== 'en';
  const reissue = user.credentialJob?.reason === 'reissue' || user.credentialGeneration > 1;
  const expiry = new Intl.DateTimeFormat(sw ? 'sw-TZ' : 'en-TZ', { timeZone: 'Africa/Dar_es_Salaam', dateStyle: 'medium', timeStyle: 'short' }).format(user.temporaryPasswordExpiresAt);
  const title = sw ? (reissue ? 'Nenosiri jipya la Tinzel' : 'Karibu Tinzel') : (reissue ? 'New Tinzel password' : 'Welcome to Tinzel');
  const body = sw
    ? `Ingia Tinzel kwa ${user.email}, kisha weka nenosiri lako.\nNenosiri la awali: ${password}\nLinaisha ${expiry} EAT. Usilishirikishe.`
    : `Sign in to Tinzel with ${user.email}, then set your password.\nTemporary password: ${password}\nExpires ${expiry} EAT. Keep it private.`;
  const content = messageContent(title, body, sw ? 'sw' : 'en', `${notificationFrontendUrl()}/staff`, sw ? 'Ingia' : 'Sign in');
  if (channel !== 'email') delete content.html;
  return content;
}

export function clientOtpMessage(order, code, validityMinutes = 10) {
  const sw = order.clientPreferredLanguage !== 'en';
  const title = sw ? 'Msimbo wa kuingia Tinzel' : 'Tinzel sign-in code';
  const ref = order.trackingId || '';
  const body = sw
    ? `${code} ni msimbo wako wa Tinzel. Unaisha baada ya dakika ${validityMinutes}. Usiushirikishe.`
    : `${code} is your Tinzel sign-in code. It expires in ${validityMinutes} minutes. Do not share it.`;
  return messageContent(title, [body, ref].filter(Boolean).join('\n'), sw ? 'sw' : 'en', `${notificationFrontendUrl()}/track`, sw ? 'Fuatilia oda' : 'Track order');
}
