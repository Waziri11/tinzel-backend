export const MAX_SEARCH_LENGTH = 64;

/**
 * Safely escapes regular expression metacharacters and bounds query length
 * to prevent Regular Expression Denial of Service (ReDoS) and syntax errors.
 */
export function escapeRegex(input = '') {
  return String(input || '')
    .trim()
    .slice(0, MAX_SEARCH_LENGTH)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds MongoDB $or search clauses for Order queries, using anchored prefix
 * regexes for tracking/submission IDs so B-tree indexes can be utilized.
 */
export function buildOrderSearchClauses(rawSearch = '') {
  const trimmed = String(rawSearch || '').trim().slice(0, MAX_SEARCH_LENGTH);
  if (!trimmed) return null;
  const escaped = escapeRegex(trimmed);
  const anchoredRx = new RegExp(`^${escaped}`, 'i');

  if (/^(TNZ|SUB)[-0-9A-Z]*$/i.test(trimmed)) {
    return [{ trackingId: anchoredRx }, { submissionId: anchoredRx }];
  }

  const containsRx = new RegExp(escaped, 'i');
  return [
    { trackingId: anchoredRx },
    { submissionId: anchoredRx },
    { clientName: containsRx },
    { clientWhatsApp: containsRx },
    { clientEmail: containsRx },
    { formTitle: containsRx },
  ];
}
