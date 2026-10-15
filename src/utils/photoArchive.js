import path from 'node:path';

export const photoFolderName = (photo) =>
  typeof photo.folderName === 'string' && photo.folderName.trim()
    ? photo.folderName.trim()
    : 'General Photos';

const safePart = (value, fallback) =>
  String(value || '')
    .replace(/[\\/\u0000-\u001f\u007f]/g, '_')
    .replace(/^\.+$/, '')
    .trim() || fallback;

export const photoArchiveEntries = (photos, requestedFolder, uploadsDir) => {
  const folder = safePart(requestedFolder, 'General Photos');
  const usedNames = new Set();

  return (photos || [])
    .filter((photo) => photoFolderName(photo) === requestedFolder)
    .map((photo, index) => {
      if (typeof photo.url !== 'string' || !/^\/uploads\/photos\/[a-zA-Z0-9._-]+$/.test(photo.url)) {
        throw new Error('Photo has an invalid stored path');
      }

      const storedName = path.posix.basename(photo.url);
      const original = path.posix.basename(String(photo.originalName || '').replaceAll('\\', '/'));
      const safeName = safePart(original, `photo-${index + 1}${path.extname(storedName)}`);
      const extension = path.extname(safeName);
      const stem = safeName.slice(0, safeName.length - extension.length);
      let entryName = safeName;
      let copy = 2;
      while (usedNames.has(entryName.toLowerCase())) {
        entryName = `${stem} (${copy})${extension}`;
        copy += 1;
      }
      usedNames.add(entryName.toLowerCase());

      return {
        diskPath: path.join(uploadsDir, storedName),
        archiveName: `${folder}/${entryName}`,
      };
    });
};

export const photoArchiveFileName = (trackingId, folder) => {
  const slug = (value) => String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${slug(trackingId) || 'order'}-${slug(folder) || 'photos'}.zip`;
};
