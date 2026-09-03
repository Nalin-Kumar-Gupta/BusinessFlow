import { ApiError } from '../errors/api-error.js';
import { assertObject } from './json.js';

export interface CheckoutRequest {
  planKey: string;
}

export function validateCheckoutRequest(input: unknown): CheckoutRequest {
  assertObject(input);
  const planKey = input['planKey'];
  if (typeof planKey !== 'string' || planKey.trim().length === 0) {
    throw new ApiError({
      code: 'VALIDATION_ERROR',
      status: 422,
      message: 'planKey is required',
      details: { field: 'planKey' },
    });
  }

  return { planKey: planKey.trim() };
}
