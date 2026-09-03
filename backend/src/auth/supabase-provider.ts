import { createLocalJWKSet, jwtVerify } from 'jose';
import { extractCredentials, resolveEnv, verifyCredentials } from '@supabase/server/core';
import { ApiError } from '../errors/api-error.js';
import type { AuthProvider, ProviderAuthResult, ProviderUserProfile } from './provider.js';

// ---------------------------------------------------------------------------
// Supabase @supabase/server integration
// ---------------------------------------------------------------------------

/**
 * Resolved JWT claims returned by verifySupabaseJwt.
 */
export interface SupabaseJwtClaims {
  sub?: string;
  email?: string;
  role?: string;
  exp?: number;
  aud?: string | string[];
}

/**
 * Verifies a Supabase-issued JWT against the project's JWKS endpoint.
 * Returns the decoded claims on success. Throws ApiError on failure.
 *
 * Uses `jose` (bundled with @supabase/server) for edge-compatible JWKS fetch
 * and RS256 verification. Prefer this over `/auth/v1/user` round-trips when
 * you only need to validate a token and read standard claims.
 *
 * @param token - The raw JWT string (without "Bearer " prefix).
 * @param jwksUrl - The full JWKS URL, e.g. https://<ref>.supabase.co/auth/v1/.well-known/jwks.json
 */
export async function verifySupabaseJwt(token: string, jwksUrl: string): Promise<SupabaseJwtClaims> {
  let jwksResponse: Response;
  try {
    jwksResponse = await fetch(jwksUrl);
  } catch {
    throw new ApiError({ code: 'AUTH_JWKS_FETCH_FAILED', status: 502, message: 'Failed to reach Supabase JWKS endpoint' });
  }

  if (!jwksResponse.ok) {
    throw new ApiError({ code: 'AUTH_JWKS_FETCH_FAILED', status: 502, message: 'Supabase JWKS endpoint returned an error' });
  }

  const jwks = (await jwksResponse.json()) as { keys: object[] };
  const keySet = createLocalJWKSet(jwks);

  try {
    const { payload } = await jwtVerify(token, keySet, { algorithms: ['RS256', 'HS256'] });
    return payload as SupabaseJwtClaims;
  } catch {
    throw new ApiError({ code: 'AUTH_JWT_INVALID', status: 401, message: 'JWT verification failed — token may be expired or invalid' });
  }
}

/**
 * Uses @supabase/server/core `verifyCredentials` to authenticate a request.
 * This integrates the official Supabase server SDK's auth flow for bearer token
 * verification, honouring Supabase publishable/secret key auth modes.
 *
 * On Cloudflare Workers, env vars must be passed explicitly via `env` overrides
 * because `process.env` is not available.
 *
 * @param request - The incoming Request object.
 * @param supabaseUrl - Supabase project URL.
 * @param supabasePublishableKey - The anon/publishable key.
 * @param supabaseSecretKey - The service-role/secret key.
 * @param jwksUrl - The project JWKS URL for JWT verification.
 */
export async function verifySupabaseRequest(
  request: Request,
  supabaseUrl: string,
  supabasePublishableKey: string,
  supabaseSecretKey: string,
  jwksUrl: string,
): Promise<ReturnType<typeof verifyCredentials>> {
  const credentials = extractCredentials(request);
  const env = resolveEnv({
    SUPABASE_URL: supabaseUrl,
    SUPABASE_PUBLISHABLE_KEY: supabasePublishableKey,
    SUPABASE_SECRET_KEY: supabaseSecretKey,
    SUPABASE_JWKS_URL: jwksUrl,
  });
  return verifyCredentials(credentials, env);
}


interface SupabaseSessionPayload {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: {
    id: string;
    email?: string | null;
  };
}

interface SupabaseUserPayload {
  id: string;
  email?: string | null;
}

interface SupabaseErrorPayload {
  error_description?: string;
  msg?: string;
  message?: string;
}

function parseJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

export class SupabaseAuthProvider implements AuthProvider {
  constructor(
    private readonly supabaseUrl: string,
    private readonly supabaseAnonKey: string,
  ) {}

  private async callSessionEndpoint(path: string, body: Record<string, unknown>): Promise<ProviderAuthResult> {
    const response = await fetch(`${this.supabaseUrl}${path}`, {
      method: 'POST',
      headers: {
        apikey: this.supabaseAnonKey,
        authorization: `Bearer ${this.supabaseAnonKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const payload: SupabaseErrorPayload = await parseJson<SupabaseErrorPayload>(response).catch(() => ({} as SupabaseErrorPayload));
      throw new ApiError({
        code: response.status === 400 || response.status === 401 ? 'AUTH_INVALID_CREDENTIALS' : 'AUTH_PROVIDER_ERROR',
        status: response.status === 400 || response.status === 401 ? 401 : 502,
        message: payload.error_description || payload.msg || payload.message || 'Authentication provider request failed',
      });
    }

    const payload = await parseJson<SupabaseSessionPayload>(response);
    if (!payload.user?.id || !payload.access_token || !payload.refresh_token || !payload.expires_in) {
      throw new ApiError({
        code: 'AUTH_PROVIDER_INVALID_RESPONSE',
        status: 502,
        message: 'Authentication provider returned malformed session payload',
      });
    }

    return {
      providerUserId: payload.user.id,
      email: payload.user.email ?? '',
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      accessTokenExpiresInSec: payload.expires_in,
    };
  }

  signup(email: string, password: string): Promise<ProviderAuthResult> {
    return this.callSessionEndpoint('/auth/v1/signup', { email, password });
  }

  login(email: string, password: string): Promise<ProviderAuthResult> {
    return this.callSessionEndpoint('/auth/v1/token?grant_type=password', { email, password });
  }

  refresh(refreshToken: string): Promise<ProviderAuthResult> {
    return this.callSessionEndpoint('/auth/v1/token?grant_type=refresh_token', { refresh_token: refreshToken });
  }

  async getUser(accessToken: string): Promise<ProviderUserProfile> {
    const response = await fetch(`${this.supabaseUrl}/auth/v1/user`, {
      method: 'GET',
      headers: {
        apikey: this.supabaseAnonKey,
        authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new ApiError({
        code: 'AUTH_TOKEN_INVALID',
        status: 401,
        message: 'Access token is invalid or expired',
      });
    }

    const payload = await parseJson<SupabaseUserPayload>(response);
    if (!payload.id) {
      throw new ApiError({
        code: 'AUTH_PROVIDER_INVALID_RESPONSE',
        status: 502,
        message: 'Authentication provider returned malformed user payload',
      });
    }

    return {
      providerUserId: payload.id,
      email: payload.email ?? '',
    };
  }

  async logout(accessToken: string): Promise<void> {
    await fetch(`${this.supabaseUrl}/auth/v1/logout`, {
      method: 'POST',
      headers: {
        apikey: this.supabaseAnonKey,
        authorization: `Bearer ${accessToken}`,
      },
    });
  }
}
