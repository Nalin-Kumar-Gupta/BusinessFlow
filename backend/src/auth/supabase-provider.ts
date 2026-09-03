import { ApiError } from '../errors/api-error.js';
import type { AuthProvider, ProviderAuthResult, ProviderUserProfile } from './provider.js';

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
