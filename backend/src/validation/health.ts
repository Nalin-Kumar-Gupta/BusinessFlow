import { ApiError } from '../errors/api-error.js';
import { assertObject } from './json.js';

export interface HealthCheckRequest {
  mode: 'liveness' | 'readiness';
}

export function validateHealthCheckRequest(input: unknown): HealthCheckRequest {
  assertObject(input);
  const mode = input['mode'];
  if (mode !== 'liveness' && mode !== 'readiness') {
    throw new ApiError({
      code: 'VALIDATION_ERROR',
      status: 422,
      message: 'mode must be either liveness or readiness',
      details: { field: 'mode' },
    });
  }

  return { mode };
}
