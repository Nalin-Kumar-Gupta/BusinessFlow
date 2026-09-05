const MAX_QUERY_LEN = 512;
const MAX_URL_LEN = 2048;

// Query parameters whose VALUES are always redacted (keys preserved).
const SENSITIVE_PARAMS = new Set([
  'token', 'access_token', 'api_key', 'apikey', 'key', 'secret',
  'password', 'passwd', 'pass', 'pwd', 'auth', 'authorization',
  'session', 'sess', 'sid', 'jwt', 'bearer',
  'client_secret', 'private_key', 'code', 'credential',
]);

export function redactUrl(raw: string): string {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return raw.slice(0, MAX_URL_LEN); }

  parsed.username = '';
  parsed.password = '';

  // Redact sensitive query param values
  const params = parsed.searchParams;
  for (const [key] of [...params.entries()]) {
    if (SENSITIVE_PARAMS.has(key.toLowerCase())) {
      params.set(key, '[REDACTED]');
    }
  }

  // Truncate on the serialized form. Assigning an ellipsis into parsed.search
  // would be percent-encoded by the URL serializer and defeat the marker.
  let result = parsed.toString();

  if (parsed.search.length > MAX_QUERY_LEN) {
    const queryStart = result.indexOf('?');
    if (queryStart !== -1) {
      result = result.slice(0, queryStart + MAX_QUERY_LEN) + '…';
    }
  }

  return result.length > MAX_URL_LEN ? result.slice(0, MAX_URL_LEN) + '…' : result;
}

export function safeOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return ''; }
}

export function safePath(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}

export function urlMatchesScope(url: string, scopeOrigins: string[]): boolean {
  let origin: string;
  try { origin = new URL(url).origin; } catch { return false; }
  return scopeOrigins.some((pattern) => {
    const base = pattern.replace(/\/\*$/, '');
    try { return new URL(base).origin === origin; } catch { return false; }
  });
}

export function originToPattern(origin: string): string {
  if (!origin || origin === 'null') return '';

  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';

    // Chrome host permission patterns do not support explicit ports.
    // Normalize localhost:3000 -> localhost so dev setups stop failing contains/request checks.
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return '';
  }
}

export function extractOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch { return ''; }
}
