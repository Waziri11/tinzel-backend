// Resolve from the saved annotation so existing returns work without copying media or migrating orders.
export function revisionCommentAudio(annotations, round, item) {
  if (!item?.annotationId) return null;
  const annotation = (annotations || []).find(annotation =>
    String(annotation._id) === String(item.annotationId) && annotation.submittedAt &&
    annotation.source === round.source && annotation.version === round.draftVersionNumber);
  return annotation?.attachments?.find(attachment => attachment.contentType?.startsWith('audio/')) || null;
}

export function revisionAudioMetadata(annotations, round, item) {
  if (item.audio?.assetId) return { contentType: item.audio.contentType, size: item.audio.size };
  const attachment = revisionCommentAudio(annotations, round, item);
  return attachment ? { contentType: attachment.contentType } : undefined;
}

export function revisionWithAudio(round, annotations) {
  const value = round.toObject ? round.toObject() : round;
  return { ...value, items: (value.items || []).map(item => {
    const audio = revisionAudioMetadata(annotations, value, item);
    return { ...item, ...(audio ? { audio } : {}) };
  }) };
}
