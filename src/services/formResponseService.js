const hasValue = (value) => {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== undefined && value !== null && String(value).trim() !== '';
};

export const validateFormAnswers = (fields, answers, uploadedPhotos = []) => {
  const errors = [];
  const safeAnswers = answers && typeof answers === 'object' ? answers : {};

  for (const field of fields || []) {
    if (!field.required) continue;
    if (field.type === 'photo_upload' || field.type === 'photo_group') {
      if (!uploadedPhotos.some((photo) => photo.fieldId === field.fieldId)) {
        errors.push(`${field.label} is required`);
      }
      continue;
    }

    const answer = safeAnswers[field.fieldId];
    if (field.type === 'grid_radio' || field.type === 'grid_checkbox') {
      const everyRowAnswered = (field.rows || []).every((row) => hasValue(answer?.[row]));
      if (!everyRowAnswered) errors.push(`${field.label} is required`);
    } else if (!hasValue(answer)) {
      errors.push(`${field.label} is required`);
    }
  }
  return errors;
};
