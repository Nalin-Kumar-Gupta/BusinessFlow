export interface CookieSerializeOptions {
  maxAgeSeconds?: number;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
}

export function parseCookie(headerValue: string | null, name: string): string | undefined {
  if (!headerValue) return undefined;
  const segments = headerValue.split(';');
  for (const segment of segments) {
    const [rawName, ...rest] = segment.trim().split('=');
    if (rawName !== name) continue;
    const value = rest.join('=');
    if (!value) return undefined;
    return decodeURIComponent(value);
  }
  return undefined;
}

export function serializeCookie(name: string, value: string, options: CookieSerializeOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (typeof options.maxAgeSeconds === 'number') parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure !== false) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}
