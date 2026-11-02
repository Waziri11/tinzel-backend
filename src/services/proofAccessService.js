export function releasedVersion(order) {
  return Math.max(0, ...(order?.draftVersions || [])
    .filter(draft => draft.managerReview?.status === 'approved')
    .map(draft => draft.versionNumber));
}
export function clientCanReadVersion(order, version) {
  return Number.isInteger(version) && version > 0 && version === releasedVersion(order);
}
