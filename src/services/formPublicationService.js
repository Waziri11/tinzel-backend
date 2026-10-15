export const validateFormForPublication = (form) => {
  const errors = [];
  const text = (value) => typeof value === 'string' && value.trim().length > 0;

  if (!text(form?.title)) errors.push('Magazine edition title is required');
  if (!text(form?.coverImageUrl)) errors.push('A magazine cover image is required');
  if (!Number.isFinite(Number(form?.price)) || Number(form.price) <= 0) errors.push('A valid price is required');
  if (!text(form?.currency)) errors.push('Currency is required');
  if (!Array.isArray(form?.sections) || form.sections.length === 0) errors.push('At least one section is required');
  if (!Array.isArray(form?.fields) || form.fields.length === 0) errors.push('At least one question is required');
  if ((form?.fields || []).some((field) => !text(field.label))) errors.push('Every question must have a label');
  const fieldIds = (form?.fields || []).map((field) => field.fieldId);
  if (new Set(fieldIds).size !== fieldIds.length) errors.push('Every question must have a unique ID');
  for (const field of form?.fields || []) {
    if (['dropdown', 'radio', 'checkbox'].includes(field.type) && (!Array.isArray(field.options) || field.options.length === 0)) {
      errors.push(`${field.label} must have at least one option`);
    }
    if (['grid_radio', 'grid_checkbox'].includes(field.type) && (!field.rows?.length || !field.options?.length)) {
      errors.push(`${field.label} must have rows and columns`);
    }
    if (field.type === 'linear_scale' && !(Number(field.scaleConfig?.low) < Number(field.scaleConfig?.high))) {
      errors.push(`${field.label} must have a valid scale range`);
    }
    if (field.type === 'rating' && (Number(field.ratingConfig?.levelCount) < 3 || Number(field.ratingConfig?.levelCount) > 10)) {
      errors.push(`${field.label} must have between 3 and 10 rating levels`);
    }
  }
  if (!text(form?.lipaNambaInstructions?.tillNumber)) errors.push('Lipa Namba is required');
  if (!text(form?.lipaNambaInstructions?.accountName)) errors.push('Payment account name is required');
  if (!text(form?.lipaNambaInstructions?.instructions)) errors.push('Payment instructions are required');

  return errors;
};
