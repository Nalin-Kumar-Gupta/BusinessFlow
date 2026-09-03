import type { ApiErrorBody, ApiSuccess } from '../types.js';

export function jsonSuccess<T>(data: T, requestId: string, status = 200): Response {
  const body: ApiSuccess<T> = {
    success: true,
    data,
    requestId,
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function jsonError(
  code: string,
  message: string,
  requestId: string,
  status: number,
  details?: unknown,
): Response {
  const body: ApiErrorBody = {
    success: false,
    requestId,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };

  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
