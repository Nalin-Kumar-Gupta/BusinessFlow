// Allowlist of safe response headers to record. Anything not listed is dropped.
// We never record: Authorization, Cookie, Set-Cookie, or any auth/credential
// headers. This list is intentionally conservative.
const ALLOWED_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-encoding',
  'cache-control',
  'expires',
  'etag',
  'last-modified',
  'x-request-id',
  'x-trace-id',
  'x-correlation-id',
  'x-response-time',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'retry-after',
  'location',
  'server',
  'vary',
  'age',
  'date',
]);

export interface FilteredHeaders {
  allowed: Record<string, string>;
  droppedCount: number;
}

export function filterResponseHeaders(
  headers: Array<{ name: string; value?: string }>,
): FilteredHeaders {
  const allowed: Record<string, string> = {};
  let droppedCount = 0;

  for (const h of headers) {
    const name = h.name.toLowerCase();
    if (ALLOWED_RESPONSE_HEADERS.has(name) && h.value !== undefined) {
      allowed[name] = h.value;
    } else {
      droppedCount++;
    }
  }

  return { allowed, droppedCount };
}
