// Commit the new version and its predecessor's cleanup references in one order save.
// Never remove source bytes before a replacement has been successfully submitted.
export function keepLatestDraft(order, now = new Date()) {
  const current = order.draftVersions.find(draft => draft.versionNumber === order.currentDraftVersion);
  if (!current || order.draftVersions.some(draft => draft.versionNumber > current.versionNumber)) return false;
  const old = order.draftVersions.filter(draft => draft.versionNumber < order.currentDraftVersion);
  if (!old.length) return false;
  order.supersededDrafts ||= [];
  for (const draft of old) {
    if (order.supersededDrafts.some(saved => saved.versionNumber === draft.versionNumber)) continue;
    order.supersededDrafts.push({
      versionNumber: draft.versionNumber, assetId: draft.assetId, storageProvider: draft.storageProvider,
      blobPath: draft.blobPath, fileUrl: draft.fileUrl, previewPages: [...(draft.previewPages || [])],
      uploadSessionId: draft.uploadSessionId, supersededAt: now,
    });
  }
  order.draftVersions = [current];
  return true;
}
