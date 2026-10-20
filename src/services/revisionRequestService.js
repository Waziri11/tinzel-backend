export const activeRevisionRequest = (order) => order.revisionRequests?.find(
  (request) => request.status === 'open' || request.status === 'submitted_for_review'
);

export const normalizeCorrectionItems = (body = {}) => {
  const supplied = Array.isArray(body.items) ? body.items : [];
  const raw = supplied.length ? supplied : body.feedback ? [{ text: body.feedback }] : [];
  const items = raw.map((item) => ({
    text: String(item?.text || '').trim(),
    pageReference: String(item?.pageReference || '').trim(),
  })).filter((item) => item.text);
  if (!items.length) {
    const error = new Error('Add at least one required fix');
    error.status = 400;
    throw error;
  }
  return items;
};

export const assertExpectedVersion = (order, expectedVersion) => {
  if (expectedVersion === undefined || expectedVersion === null || expectedVersion === '') return;
  if (Number(expectedVersion) !== Number(order.currentDraftVersion)) {
    const error = new Error('This order changed in another session. Refresh before continuing.');
    error.status = 409;
    throw error;
  }
};

export const closeActiveRevision = (order, resolution) => {
  const active = activeRevisionRequest(order);
  if (!active) return null;
  active.status = 'resolved';
  active.resolution = resolution;
  active.resolvedAt = new Date();
  return active;
};

export const createRevisionRequest = (order, { source, actor, items }) => {
  if (activeRevisionRequest(order)) {
    const error = new Error('This order already has an active return');
    error.status = 409;
    throw error;
  }
  order.revisionRequests.push({
    roundNumber: (order.revisionRequests?.length || 0) + 1,
    draftVersionNumber: order.currentDraftVersion,
    source,
    requestedBy: actor,
    items,
  });
  return order.revisionRequests[order.revisionRequests.length - 1];
};
