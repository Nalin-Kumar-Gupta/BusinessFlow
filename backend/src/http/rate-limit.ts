import { ApiError } from '../errors/api-error.js';

interface RateCounter {
  windowStartMs: number;
  count: number;
}

interface RateLimitInput {
  bucket: string;
  key: string;
  limit: number;
  windowMs: number;
  nowMs?: number;
}

const store = new Map<string, RateCounter>();

function getStoreKey(bucket: string, key: string): string {
  return `${bucket}:${key}`;
}

function normalizeClientKey(request: Request): string {
  const cfIp = request.headers.get('cf-connecting-ip')?.trim();
  if (cfIp) return cfIp;

  const xff = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (xff) return xff;

  return 'unknown';
}

export function enforceRateLimit(request: Request, input: Omit<RateLimitInput, 'key'> & { key?: string }): void {
  const nowMs = input.nowMs ?? Date.now();
  const key = input.key ?? normalizeClientKey(request);
  if (key === 'unknown') return;
  const storeKey = getStoreKey(input.bucket, key);
  const existing = store.get(storeKey);

  if (!existing || (nowMs - existing.windowStartMs) >= input.windowMs) {
    store.set(storeKey, { windowStartMs: nowMs, count: 1 });
    return;
  }

  existing.count += 1;
  if (existing.count <= input.limit) return;

  throw new ApiError({
    code: 'RATE_LIMITED',
    status: 429,
    message: 'Too many requests. Please retry later.',
    details: {
      bucket: input.bucket,
      retryAfterSeconds: Math.max(1, Math.ceil((input.windowMs - (nowMs - existing.windowStartMs)) / 1000)),
    },
  });
}

export function resetRateLimitStoreForTests(): void {
  store.clear();
}
