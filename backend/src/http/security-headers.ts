import type { AppEnvironment } from '../types.js';

export function applySecurityHeaders(response: Response, env: AppEnvironment): Response {
  const headers = new Headers(response.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  headers.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if (env !== 'local') {
    headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains; preload');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
