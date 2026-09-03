import { ApiError } from '../errors/api-error.js';
import { assertObject } from './json.js';

export interface AuthCredentialInput {
  email: string;
  password: string;
}

function normalizeEmail(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ApiError({
      code: 'VALIDATION_ERROR',
      status: 422,
      message: 'email is required',
      details: { field: 'email' },
    });
  }

  const email = raw.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new ApiError({
      code: 'VALIDATION_ERROR',
      status: 422,
      message: 'email must be valid',
      details: { field: 'email' },
    });
  }

  return email;
}

function normalizePassword(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ApiError({
      code: 'VALIDATION_ERROR',
      status: 422,
      message: 'password is required',
      details: { field: 'password' },
    });
  }

  if (raw.length < 8 || raw.length > 128) {
    throw new ApiError({
      code: 'VALIDATION_ERROR',
      status: 422,
      message: 'password must be between 8 and 128 characters',
      details: { field: 'password' },
    });
  }

  return raw;
}

export function validateCredentialRequest(input: unknown): AuthCredentialInput {
  assertObject(input);
  return {
    email: normalizeEmail(input['email']),
    password: normalizePassword(input['password']),
  };
}
