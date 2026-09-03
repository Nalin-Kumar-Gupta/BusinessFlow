import type { EnvBindings } from '../../../backend/src/types.js';

class FakeStatement implements D1PreparedStatement {
  bind(..._values: unknown[]): D1PreparedStatement {
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    return { ok: 1 } as T;
  }

  async run(): Promise<D1RunResult> {
    return { success: true };
  }

  async all<T = unknown>(): Promise<D1AllResult<T>> {
    return { results: [] };
  }
}

export const fakeD1: D1Database = {
  prepare(_query: string) {
    return new FakeStatement();
  },
};

export function makeEnv(overrides: Partial<EnvBindings> = {}): EnvBindings {
  return {
    APP_ENV: 'local',
    API_VERSION: 'v1',
    LOG_LEVEL: 'debug',
    ALLOWED_ORIGINS: 'http://localhost:3000,chrome-extension://abc123',
    AUTH_PROVIDER: 'supabase',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'public-anon-key',
    SESSION_COOKIE_NAME: 'bf_session',
    SESSION_TTL_SECONDS: '3600',
    SESSION_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    PADDLE_ENV: 'sandbox',
    PADDLE_API_BASE_URL: 'https://sandbox-api.paddle.com',
    PADDLE_API_KEY: 'pdl_test_key',
    PADDLE_CLIENT_TOKEN: 'test_client_token_123',
    PADDLE_WEBHOOK_SECRET: 'whsec_test_secret',
    PADDLE_PRICE_IDS_JSON: '{"starter-monthly":"pri_starter_monthly","starter-yearly":"pri_starter_yearly","pro-monthly":"pri_pro_monthly","pro-yearly":"pri_pro_yearly","advanced-monthly":"pri_advanced_monthly","advanced-yearly":"pri_advanced_yearly"}',
    PADDLE_PRODUCT_IDS_JSON: '{"starter":"pro_starter","pro":"pro_pro","advanced":"pro_advanced"}',
    PADDLE_CHECKOUT_SUCCESS_URL: 'http://localhost:3000/billing/success',
    PADDLE_CHECKOUT_CANCEL_URL: 'http://localhost:3000/billing/cancel',
    ENTITLEMENT_REFRESH_INTERVAL_SECONDS: '300',
    ENTITLEMENT_CACHE_MAX_AGE_SECONDS: '900',
    ENTITLEMENT_OFFLINE_GRACE_SECONDS: '900',
    DB: fakeD1,
    ...overrides,
  };
}

export function readSetCookie(response: Response): string {
  return response.headers.get('set-cookie') ?? '';
}
