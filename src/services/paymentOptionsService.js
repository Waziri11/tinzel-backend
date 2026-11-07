import { SystemConfig } from '../models/SystemConfig.model.js';

export const PAYMENT_OPTIONS_KEY = 'payment_options';
const limits = { id: 80, name: 120, nameSw: 120, number: 120, accountName: 160, instructions: 2000, instructionsSw: 2000 };
const types = ['till', 'mobile', 'bank', 'other'];
export function validPaymentOptions(value) {
  return Array.isArray(value) && value.length <= 20 && new Set(value.map(option => typeof option?.id === 'string' ? option.id.trim() : option?.id)).size === value.length && value.every(option =>
    option && typeof option === 'object' && !Array.isArray(option) &&
    Object.keys(option).every(key => [...Object.keys(limits), 'type', 'enabled'].includes(key)) &&
    types.includes(option.type) && typeof option.enabled === 'boolean' &&
    Object.entries(limits).every(([key, max]) => (option[key] === undefined && ['nameSw', 'instructionsSw'].includes(key)) ||
      (typeof option[key] === 'string' && option[key].length <= max && (['nameSw', 'instructionsSw'].includes(key) || option[key].trim().length > 0)))
  );
}
export const cleanPaymentOptions = options => options.map(option => Object.fromEntries(Object.entries(option).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value])));

// An explicitly saved empty list must never revive a removed payment destination.
export async function getPublicPaymentDetails(legacy) {
  const saved = await SystemConfig.findOne({ key: PAYMENT_OPTIONS_KEY }).lean();
  const paymentOptions = saved
    ? (validPaymentOptions(saved.value) ? cleanPaymentOptions(saved.value).filter(option => option.enabled) : [])
    : legacy?.tillNumber ? [{ id: 'legacy-till', type: 'till', enabled: true, name: 'Lipa Namba', number: legacy.tillNumber,
      accountName: legacy.accountName || '', instructions: legacy.instructions || '', instructionsSw: legacy.instructionsSw || '' }] : [];
  const till = paymentOptions.find(option => option.type === 'till');
  return { paymentOptions, lipaNambaInstructions: till ? { tillNumber: till.number, accountName: till.accountName, instructions: till.instructions, instructionsSw: till.instructionsSw || '' } : null };
}
