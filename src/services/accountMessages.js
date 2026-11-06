import { notificationFrontendUrl } from './notificationUrls.js';

export const roleLabels = {
  en: { admin: 'Administrator', manager: 'Manager', designer: 'Designer', printer: 'Printing partner', client: 'Customer' },
  sw: { admin: 'Msimamizi wa mfumo', manager: 'Meneja', designer: 'Mbunifu', printer: 'Mshirika wa uchapishaji', client: 'Mteja' },
};
const responsibilities = {
  en: { admin: 'Manage staff and oversee magazine orders, reviews, printing and delivery.', manager: 'Verify payments, assign designers, review drafts and authorize printing and delivery.', designer: 'Design assigned magazines, complete corrections and prepare approved print files.' },
  sw: { admin: 'Simamia watumishi na oda za majarida, ukaguzi, uchapishaji na uwasilishaji.', manager: 'Thibitisha malipo, kabidhi wabunifu kazi, kagua rasimu na idhinisha uchapishaji na usafirishaji.', designer: 'Sanifu majarida uliyokabidhiwa, kamilisha marekebisho na andaa faili zilizoidhinishwa za uchapishaji.' },
};
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export function messageContent(title, message, lang, actionUrl, actionLabel) {
  return { title, message, html: `<html lang="${lang}"><body style="font-family:Arial,sans-serif;line-height:1.6;color:#25221d"><h2>${escape(title)}</h2><p>${escape(message).replaceAll('\n', '<br>')}</p>${actionUrl ? `<p><a href="${escape(actionUrl)}">${escape(actionLabel || (lang === 'sw' ? 'Fungua Tinzel' : 'Open Tinzel'))}</a></p>` : ''}</body></html>` };
}
export function staffCredentialMessage(user, password, channel) {
  const lang = user.preferredLanguage === 'en' ? 'en' : 'sw', sw = lang === 'sw';
  const reissue = user.credentialJob?.reason === 'reissue' || user.credentialGeneration > 1;
  const role = roleLabels[lang][user.role], url = `${notificationFrontendUrl()}/staff`;
  const expiry = new Intl.DateTimeFormat(sw ? 'sw-TZ' : 'en-TZ', { timeZone: 'Africa/Dar_es_Salaam', dateStyle: 'medium', timeStyle: 'short' }).format(user.temporaryPasswordExpiresAt);
  const title = sw ? (reissue ? 'Tinzel: nenosiri jipya la awali limetolewa' : 'Karibu Tinzel: akaunti yako iko tayari') : (reissue ? 'Tinzel: new initial password issued' : 'Welcome to Tinzel: your account is ready');
  const text = sw
    ? `Habari ${user.name},\n${reissue ? 'Msimamizi amekutolea nenosiri jipya la awali. Nenosiri la zamani halitumiki tena na vipindi vyote vya kuingia vimefungwa.' : 'Msimamizi amekuundia akaunti ya Tinzel.'}\nJina: ${user.name}\nWadhifa: ${role}\nMajukumu: ${responsibilities.sw[user.role]}\nBarua pepe ya kuingia: ${user.email}\nNenosiri la awali: ${password}\nLinaisha: ${expiry} EAT (saa 24 tangu kutolewa).\nIngia: ${url}\nTumia barua pepe na nenosiri hili, kisha weka nenosiri lako kabla ya kuanza kazi. Tumia angalau herufi 8.\nUsishirikishe mtu nenosiri hili. Likishaisha au ukihitaji msaada, wasiliana na msimamizi wako.`
    : `Hello ${user.name},\n${reissue ? 'An administrator has issued a new initial password. Your previous password no longer works and existing sessions have been signed out.' : 'An administrator has created your Tinzel account.'}\nName: ${user.name}\nRole: ${role}\nResponsibilities: ${responsibilities.en[user.role]}\nSign-in email: ${user.email}\nInitial password: ${password}\nExpires: ${expiry} EAT (24 hours from issue).\nSign in: ${url}\nUse this email and initial password, then choose your own password before starting work. Use at least 8 characters.\nDo not share this password. If it expires or you need help, contact your administrator.`;
  const content = messageContent(title, text, lang, url, sw ? 'Ingia na uweke nenosiri lako' : 'Sign in and set your password');
  if (channel !== 'email') delete content.html;
  return content;
}

export function clientOtpMessage(order, code, validityMinutes = 10) {
  const lang = order.clientPreferredLanguage === 'en' ? 'en' : 'sw', sw = lang === 'sw';
  const ref = order.trackingId || order.submissionId, url = `${notificationFrontendUrl()}/track`;
  const title = sw ? 'Tinzel: namba ya kuthibitisha kuingia' : 'Tinzel: sign-in verification code';
  const text = sw
    ? `Habari ${order.clientName || 'Mteja'},\n${ref ? `Oda: ${ref}\n` : ''}Namba yako ya siri (OTP): ${code}\nTumia namba hii kuthibitisha kuingia kwenye ufuatiliaji wa oda: ${url}\nInaisha baada ya dakika ${validityMinutes}. Usishirikishe mtu namba hii. Ikiwa hukuomba kuingia, puuza ujumbe huu.`
    : `Hello ${order.clientName || 'Customer'},\n${ref ? `Order: ${ref}\n` : ''}Your verification code (OTP): ${code}\nEnter this code to sign in to order tracking: ${url}\nExpires in ${validityMinutes} minutes. Do not share this code. If you did not request sign-in, ignore this message.`;
  return messageContent(title, text, lang, url, sw ? 'Fungua ufuatiliaji wa oda' : 'Open order tracking');
}
