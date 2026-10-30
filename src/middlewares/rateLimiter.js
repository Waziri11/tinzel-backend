import mongoose from 'mongoose';

const rateLimitBucketSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    count: { type: Number, required: true, default: 1 },
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  { versionKey: false }
);

export const RateLimitBucket =
  mongoose.models.RateLimitBucket || mongoose.model('RateLimitBucket', rateLimitBucketSchema);

const memoryBuckets = new Map();

export async function consumeRateLimit({ scope, key, maxAttempts, windowMs }) {
  const now = Date.now();
  const bucketId = `${scope}:${key || 'anonymous'}`;
  const expiresAt = new Date(now + windowMs);

  if (mongoose.connection.readyState === 1) {
    try {
      await RateLimitBucket.deleteOne({ _id: bucketId, expiresAt: { $lte: new Date(now) } });
      const doc = await RateLimitBucket.findOneAndUpdate(
        { _id: bucketId },
        {
          $inc: { count: 1 },
          $setOnInsert: { expiresAt },
        },
        { upsert: true, returnDocument: 'after' }
      ).lean();

      const count = doc?.count || 1;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(((doc?.expiresAt ? new Date(doc.expiresAt).getTime() : now + windowMs) - now) / 1000)
      );
      return {
        allowed: count <= maxAttempts,
        count,
        remaining: Math.max(0, maxAttempts - count),
        retryAfterSeconds,
      };
    } catch {
      // Fall back to in-memory limiter if transient DB contention occurs
    }
  }

  for (const [id, entry] of memoryBuckets) {
    if (entry.until <= now) memoryBuckets.delete(id);
  }
  const existing = memoryBuckets.get(bucketId);
  const entry = existing && existing.until > now ? existing : { count: 0, until: now + windowMs };
  entry.count += 1;
  memoryBuckets.set(bucketId, entry);

  const retryAfterSeconds = Math.max(1, Math.ceil((entry.until - now) / 1000));
  return {
    allowed: entry.count <= maxAttempts,
    count: entry.count,
    remaining: Math.max(0, maxAttempts - entry.count),
    retryAfterSeconds,
  };
}

export function createRateLimiter({
  scope,
  maxAttempts = 10,
  windowMs = 15 * 60 * 1000,
  keyGenerator = (req) => req.ip || 'unknown',
  message = 'Too many requests. Please wait before trying again.',
}) {
  return async (req, res, next) => {
    try {
      const key = keyGenerator(req);
      const result = await consumeRateLimit({ scope, key, maxAttempts, windowMs });
      if (!result.allowed) {
        res.set('Retry-After', String(result.retryAfterSeconds));
        return res.status(429).json({
          success: false,
          message,
          retryAfterSeconds: result.retryAfterSeconds,
        });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
