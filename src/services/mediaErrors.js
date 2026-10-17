export const mediaError = (status, message, code = 'MEDIA_ERROR') =>
  Object.assign(new Error(message), { status, code });

export function classifyMediaError(error) {
  if (error.code === 'LIMIT_FILE_SIZE' || error.type === 'entity.too.large') {
    return { status: 413, retryable: false, code: 'PHOTO_TOO_LARGE' };
  }
  const transient = /Network|Timeout|ServerSelection|PoolCleared/i.test(error.name || '') ||
    [6, 7, 89, 91, 189, 262, 9001].includes(error.code);
  const status = error.status || (transient ? 503 : 500);
  return { status, retryable: transient || [408, 429, 502, 503, 504].includes(status),
    code: typeof error.code === 'string' ? error.code : (transient ? 'STORAGE_UNAVAILABLE' : 'STORAGE_FAILED') };
}

export function respondMediaError(req, res, error) {
  const info = classifyMediaError(error);
  console.error(JSON.stringify({ event: 'media_error', requestId: req.requestId,
    code: error.code, name: error.name, message: error.message, status: info.status }));
  return res.status(info.status).json({ success: false, ...info, requestId: req.requestId,
    message: info.status < 500 ? error.message : 'Photo storage is temporarily unavailable. Please retry this photo.' });
}
