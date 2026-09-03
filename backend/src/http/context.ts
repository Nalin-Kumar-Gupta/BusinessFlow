import type { RequestContext } from '../types.js';

export function createRequestContext(request: Request): RequestContext {
  const requestId = request.headers.get('cf-ray') || crypto.randomUUID();
  return {
    requestId,
    startedAt: Date.now(),
  };
}
