import type { AppConfig } from '../config/env.js';

export function isOriginAllowed(origin: string, config: AppConfig): boolean {
  if (origin.startsWith('chrome-extension://')) return true;
  return config.allowedOrigins.includes(origin);
}

export function applyCors(request: Request, response: Response, config: AppConfig): Response {
  const origin = request.headers.get('origin');
  if (!origin) return response;
  if (!isOriginAllowed(origin, config)) return response;

  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  headers.set('vary', 'origin');
  headers.set('access-control-allow-methods', 'GET,POST,OPTIONS');
  headers.set('access-control-allow-headers', 'content-type,authorization,x-request-id');
  headers.set('access-control-allow-credentials', 'true');
  headers.set('access-control-max-age', '600');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function handleCorsPreflight(request: Request, config: AppConfig): Response {
  const origin = request.headers.get('origin');
  if (!origin || !isOriginAllowed(origin, config)) {
    return new Response(null, { status: 403 });
  }

  return applyCors(request, new Response(null, { status: 204 }), config);
}
