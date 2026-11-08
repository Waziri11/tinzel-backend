import path from 'node:path';

export const photoFolderName = (photo) =>
  typeof photo.folderName === 'string' && photo.folderName.trim()
    ? photo.folderName.trim()
    : 'General Photos';

const safePart = (value, fallback) =>
  String(value || '')
    .normalize('NFC')
    .replace(/[\\/<>:"|?*\u0000-\u001f\u007f]/g, '_')
    .trim()
    .replace(/^\.+|[. ]+$/g, '')
    .slice(0, 100)
    .replace(/[. ]+$/g, '')
    .replace(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?=\.|$)/i, '_$1') || fallback;

const entriesForPhotos = (photos, folder, uploadsDir) => {
  const usedNames = new Set();

  return (photos || [])
    .map((photo, index) => {
      const url = typeof photo.url === 'string' ? photo.url : '';
      const isDiskPhoto = /^\/uploads\/photos\/[a-zA-Z0-9._-]+$/.test(url);
      const gridFsMatch = url.match(/^\/api\/public\/photos\/([a-f0-9]{24})$/i);
      const assetMatch = url.match(/^\/api\/public\/media\/assets\/([a-f0-9]{24})$/i);

      if (!isDiskPhoto && !gridFsMatch && !assetMatch) {
        throw new Error('Photo has an invalid stored path');
      }

      const storedName = path.posix.basename(url);
      const original = path.posix.basename(String(photo.originalName || '').replaceAll('\\', '/'));
      const defaultExt = path.extname(storedName) || '.jpg';
      const safeName = safePart(original, `photo-${index + 1}${defaultExt}`);
      const extension = path.extname(safeName) || defaultExt;
      const stem = safeName.endsWith(extension) ? safeName.slice(0, safeName.length - extension.length) : safeName;
      let entryName = `${stem}${extension}`;
      let copy = 2;
      while (usedNames.has(entryName.toLowerCase())) {
        entryName = `${stem} (${copy})${extension}`;
        copy += 1;
      }
      usedNames.add(entryName.toLowerCase());

      if (assetMatch) return { assetId: assetMatch[1], archiveName: `${folder}/${entryName}` };

      if (gridFsMatch) {
        return {
          gridFsId: gridFsMatch[1],
          archiveName: `${folder}/${entryName}`,
        };
      }

      return {
        diskPath: path.join(uploadsDir, storedName),
        archiveName: `${folder}/${entryName}`,
      };
    });
};

export const photoArchiveEntries = (photos, requestedFolder, uploadsDir) =>
  entriesForPhotos((photos || []).filter(photo => photoFolderName(photo) === requestedFolder), safePart(requestedFolder, 'General Photos'), uploadsDir);

// A field ID distinguishes different questions even when their labels are identical.
// Older submissions without field IDs retain their original photo folders.
export const allPhotoArchiveEntries = (order, uploadsDir) => {
  const fields = order.submittedFields?.length ? order.submittedFields : order.formId?.fields || [];
  const definitions = new Map(fields.map(field => [field.fieldId, field]));
  const groups = new Map();
  for (const photo of order.uploadedPhotos || []) {
    const key = photo.fieldId ? `field:${photo.fieldId}` : `folder:${photoFolderName(photo)}`;
    if (!groups.has(key)) {
      const field = definitions.get(photo.fieldId);
      groups.set(key, { label: field?.label || photoFolderName(photo), order: field?.order ?? Number.MAX_SAFE_INTEGER, photos: [] });
    }
    groups.get(key).photos.push(photo);
  }
  const root = safePart(order.clientName, 'Unnamed customer');
  const usedFolders = new Set();
  return [...groups.values()].sort((a, b) => a.order - b.order).flatMap(group => {
    const label = safePart(group.label, 'General Photos');
    let folder = label;
    let copy = 2;
    while (usedFolders.has(folder.toLowerCase())) folder = `${label} (${copy++})`;
    usedFolders.add(folder.toLowerCase());
    return entriesForPhotos(group.photos, `${root}/${folder}`, uploadsDir);
  });
};

export const photoArchiveFileName = (trackingId, folder) => {
  if (folder === null) return `${safePart(trackingId, 'Unnamed customer')}.zip`;
  const slug = (value) => String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${slug(trackingId) || 'order'}-${slug(folder) || 'photos'}.zip`;
};
