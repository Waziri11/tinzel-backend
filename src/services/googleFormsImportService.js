const ALLOWED_HOSTS = new Set(['forms.gle', 'docs.google.com']);
const MAX_REDIRECTS = 4;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10000;
const decodeHtmlEntities = (value) => value
  .replaceAll('&quot;', '"')
  .replaceAll('&#39;', "'")
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>')
  .replaceAll('&amp;', '&');

export class GoogleFormsImportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'GoogleFormsImportError';
    this.status = status;
  }
}

export const validateGoogleFormUrl = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new GoogleFormsImportError('Enter a valid Google Forms link');
  }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new GoogleFormsImportError('Only HTTPS forms.gle and docs.google.com/forms links are supported');
  }
  if (url.username || url.password) throw new GoogleFormsImportError('Google Forms links cannot include credentials');
  if (url.hostname === 'docs.google.com' && !url.pathname.startsWith('/forms/')) {
    throw new GoogleFormsImportError('The link must point to a Google Form');
  }
  url.hash = '';
  return url;
};

const readLimitedBody = async (response) => {
  const statedSize = Number(response.headers.get('content-length') || 0);
  if (statedSize > MAX_HTML_BYTES) throw new GoogleFormsImportError('Google Form is too large to import', 413);
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_HTML_BYTES) throw new GoogleFormsImportError('Google Form is too large to import', 413);
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_HTML_BYTES) {
      await reader.cancel();
      throw new GoogleFormsImportError('Google Form is too large to import', 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
};

const fetchPublicFormHtml = async (sourceUrl, fetchImpl = fetch) => {
  let url = validateGoogleFormUrl(sourceUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'User-Agent': 'Tinzel-Google-Forms-Importer/1.0', Accept: 'text/html' },
        });
      } catch (error) {
        if (error.name === 'AbortError') throw new GoogleFormsImportError('Google Form import timed out', 504);
        throw new GoogleFormsImportError('Could not reach Google Forms', 502);
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new GoogleFormsImportError('Google returned an invalid redirect', 502);
        url = validateGoogleFormUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) {
        throw new GoogleFormsImportError(response.status === 404 ? 'Google Form was not found or is unpublished' : 'Google Form could not be opened', response.status === 404 ? 404 : 502);
      }
      const contentType = response.headers.get('content-type') || '';
      if (contentType && !contentType.includes('text/html')) throw new GoogleFormsImportError('Google link did not return a form page');
      return { html: await readLimitedBody(response), finalUrl: url.toString() };
    }
    throw new GoogleFormsImportError('Google Form redirected too many times', 502);
  } finally {
    clearTimeout(timer);
  }
};

export const extractPublicLoadData = (html) => {
  const marker = 'FB_PUBLIC_LOAD_DATA_';
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) throw new GoogleFormsImportError('This form is restricted, unpublished, or no longer uses a supported public format');
  const equalsIndex = html.indexOf('=', markerIndex + marker.length);
  const start = html.indexOf('[', equalsIndex + 1);
  if (equalsIndex < 0 || start < 0) throw new GoogleFormsImportError('Google Form data could not be read');

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(decodeHtmlEntities(html.slice(start, index + 1)));
        } catch {
          throw new GoogleFormsImportError('Google Form data uses an unsupported format');
        }
      }
    }
  }
  throw new GoogleFormsImportError('Google Form data is incomplete');
};

const stringsFromOptions = (value) => Array.isArray(value)
  ? value.map((option) => Array.isArray(option) ? option[0] : option).filter((option) => typeof option === 'string' && option.trim()).map((option) => option.trim())
  : [];

const payloadOptions = (item) => {
  for (const payload of item?.[4] || []) {
    const options = stringsFromOptions(payload?.[1]);
    if (options.length) return options;
  }
  return [];
};

const isRequired = (item) => (item?.[4] || []).some((payload) => payload?.[2] === 1 || payload?.[2] === true);
const itemId = (item, index) => `google_${String(item?.[0] ?? index).replace(/[^a-zA-Z0-9_-]/g, '_')}`;

export const normalizeGoogleFormData = (data, sourceUrl = '') => {
  const form = data?.[1];
  const items = Array.isArray(form?.[1]) ? form[1] : [];
  const title = String(data?.[3] || form?.[8] || 'Imported Google Form').trim();
  const description = typeof form?.[0] === 'string' ? form[0].trim() : '';
  const sections = [{ sectionId: 'google_section_1', title: 'Form Questions', description: '', order: 1 }];
  const fields = [];
  const warnings = [];
  let currentSectionId = sections[0].sectionId;

  const addField = (item, index, type, extra = {}) => fields.push({
    fieldId: itemId(item, index), sectionId: currentSectionId,
    label: String(item?.[1] || `Question ${fields.length + 1}`).trim(),
    helperText: typeof item?.[2] === 'string' ? item[2].trim() : '',
    type, required: isRequired(item), order: fields.length + 1, options: [], rows: [],
    scaleConfig: { low: 1, high: 5, lowLabel: '', highLabel: '' },
    ratingConfig: { levelCount: 5, iconType: 'star' },
    validationRules: { minPhotos: 0, maxPhotos: 10, minChar: 0, maxChar: 5000 },
    ...extra,
  });

  items.forEach((item, index) => {
    const type = item?.[3];
    if (type === 8) {
      currentSectionId = `google_section_${sections.length + 1}`;
      sections.push({ sectionId: currentSectionId, title: String(item?.[1] || `Section ${sections.length + 1}`), description: String(item?.[2] || ''), order: sections.length + 1 });
    } else if (type === 0) addField(item, index, 'text');
    else if (type === 1) addField(item, index, 'textarea');
    else if (type === 2) addField(item, index, 'radio', { options: payloadOptions(item) });
    else if (type === 3) addField(item, index, 'dropdown', { options: payloadOptions(item) });
    else if (type === 4) addField(item, index, 'checkbox', { options: payloadOptions(item) });
    else if (type === 5) {
      const payload = item?.[4]?.[0] || [];
      const numeric = (payload?.[1] || []).flat(Infinity).filter((value) => Number.isFinite(value));
      addField(item, index, 'linear_scale', { scaleConfig: { low: numeric[0] ?? 1, high: numeric.at(-1) ?? 5, lowLabel: String(payload?.[3] || ''), highLabel: String(payload?.[4] || '') } });
    } else if (type === 7) {
      const payloads = item?.[4] || [];
      const rows = payloads.map((payload, rowIndex) => String(payload?.[3] || payload?.[0] || `Row ${rowIndex + 1}`));
      const options = payloadOptions(item);
      const checkboxGrid = payloads.some((payload) => payload?.[4] === 1);
      addField(item, index, checkboxGrid ? 'grid_checkbox' : 'grid_radio', { rows, options });
    } else if (type === 9) addField(item, index, item?.[4]?.[0]?.[7] ? 'datetime' : 'date');
    else if (type === 10) addField(item, index, item?.[4]?.[0]?.[6] ? 'duration' : 'time');
    else if (type === 13) {
      const serialized = JSON.stringify(item).toLowerCase();
      if (serialized.includes('image')) addField(item, index, 'photo_group', { validationRules: { minPhotos: isRequired(item) ? 1 : 0, maxPhotos: 10, minChar: 0, maxChar: 5000 } });
      else warnings.push(`Skipped non-image file upload: ${item?.[1] || `Item ${index + 1}`}`);
    } else if (type === 18) {
      const levelCount = Number(item?.[4]?.[0]?.[1]) || 5;
      addField(item, index, 'rating', { ratingConfig: { levelCount, iconType: 'star' } });
    } else if (type === 6) warnings.push(`Skipped informational text block: ${item?.[1] || `Item ${index + 1}`}`);
    else if (type === 11 || type === 12) warnings.push(`Skipped ${type === 11 ? 'image' : 'video'}: ${item?.[1] || `Item ${index + 1}`}`);
    else warnings.push(`Skipped unsupported Google Forms item: ${item?.[1] || `Item ${index + 1}`}`);

    const hasBranching = (item?.[4] || []).some((payload) => Array.isArray(payload?.[1]) && payload[1].some((option) =>
      Array.isArray(option) && ((option[2] !== null && option[2] !== undefined) || (option[3] !== null && option[3] !== undefined))
    ));
    if (hasBranching || JSON.stringify(item).includes('goToSection')) warnings.push(`Removed answer-based section branching from: ${item?.[1] || `Item ${index + 1}`}`);
  });

  const serializedForm = JSON.stringify(form).toLowerCase();
  if (serializedForm.includes('quiz')) warnings.push('Quiz grading and answer keys were not imported');
  if (serializedForm.includes('collectemail')) warnings.push('Google email collection was not imported; Tinzel keeps its optional client email field');
  if (!fields.length) throw new GoogleFormsImportError('No supported questions were found in this Google Form');

  return { title, description, sections, fields, warnings: [...new Set(warnings)], sourceUrl };
};

export const importGoogleForm = async (sourceUrl, { fetchImpl = fetch } = {}) => {
  const { html, finalUrl } = await fetchPublicFormHtml(sourceUrl, fetchImpl);
  const data = extractPublicLoadData(html);
  return normalizeGoogleFormData(data, finalUrl);
};
