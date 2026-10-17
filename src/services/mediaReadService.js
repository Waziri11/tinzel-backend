import { Readable } from 'node:stream';
import mongoose from 'mongoose';
import { get } from '@vercel/blob';
import { mediaError } from './mediaErrors.js';

export async function openAssetStream(asset) {
  if (asset.provider === 'blob') {
    const result = await get(asset.blobPath, { access: 'private', abortSignal: AbortSignal.timeout(240000) });
    if (!result?.stream) throw mediaError(404, 'Photo unavailable');
    return Readable.fromWeb(result.stream);
  }
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'orderPhotos' })
    .openDownloadStream(new mongoose.Types.ObjectId(asset._id));
}
