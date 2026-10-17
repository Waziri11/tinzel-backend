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

export const photoArchiveFileName = (trackingId, folder) => {
  const slug = (value) => String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${slug(trackingId) || 'order'}-${slug(folder) || 'photos'}.zip`;
};
