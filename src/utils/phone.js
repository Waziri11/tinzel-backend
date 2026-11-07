// Canonical contact format. Provider-specific restrictions belong in SMS adapters.
export function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim().replace(/[\s().-]/g, '');
  if (!value) return null;
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  if (/^0[1-9]\d{8}$/.test(value)) value = `+255${value.slice(1)}`;
  else if (/^[67]\d{8}$/.test(value)) value = `+255${value}`;
  else if (/^255[1-9]\d{8}$/.test(value)) value = `+${value}`;
  if (!/^\+[1-9]\d{7,14}$/.test(value)) return null;
  if (value.startsWith('+255') && !/^\+255[1-9]\d{8}$/.test(value)) return null;
  return value;
}

export const PHONE_ERROR = 'Enter a valid phone number. Local numbers use +255; international numbers need a country code.';
export function requirePhone(raw) {
  const phone = normalizePhone(raw);
  if (!phone) throw Object.assign(new Error(PHONE_ERROR), { status: 400 });
  return phone;
}
export function samePhone(first, second) {
  const phone = normalizePhone(first);
  return Boolean(phone && phone === normalizePhone(second));
}

export function phoneMatchPattern(raw) {
  const canonical = requirePhone(raw);
  const digits = canonical.slice(1);
  const forms = [`+${digits}`, `00${digits}`];
  if (digits.startsWith('255')) {
    forms.push(digits, `0${digits.slice(3)}`);
    if (/^[67]/.test(digits.slice(3))) forms.push(digits.slice(3));
  }
  const separator = '[\\s().-]*';
  const branches = forms.map(value => [...value].map(char => char === '+' ? '\\+' : char).join(separator));
  return new RegExp(`^${separator}(?:${branches.join('|')})${separator}$`);
}
