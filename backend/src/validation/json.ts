import { ApiError } from '../errors/api-error.js';

export async function parseJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ApiError({
      code: 'INVALID_CONTENT_TYPE',
      status: 415,
      message: 'Request must use application/json content type',
    });
  }

  try {
    return await request.json();
  } catch {
    throw new ApiError({
      code: 'INVALID_JSON',
      status: 400,
      message: 'Malformed JSON request body',
    });
  }
}

export function assertObject(input: unknown, message = 'Request body must be an object'): asserts input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError({
      code: 'VALIDATION_ERROR',
      status: 422,
      message,
    });
  }
}
