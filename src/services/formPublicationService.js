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
  if (!text(form?.lipaNambaInstructions?.tillNumber)) errors.push('Lipa Namba is required');
  if (!text(form?.lipaNambaInstructions?.accountName)) errors.push('Payment account name is required');
  if (!text(form?.lipaNambaInstructions?.instructions)) errors.push('Payment instructions are required');

  return errors;
};
