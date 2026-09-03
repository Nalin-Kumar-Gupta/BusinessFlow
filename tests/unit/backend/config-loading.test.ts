import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../backend/src/config/env.js';

const AUTH_BASE = {
  AUTH_PROVIDER: 'supabase',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  SESSION_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  PADDLE_ENV: 'sandbox',
  PADDLE_API_BASE_URL: 'https://sandbox-api.paddle.com',
  PADDLE_API_KEY: 'pdl_test_key',
  PADDLE_CLIENT_TOKEN: 'test_client_token_123',
  PADDLE_WEBHOOK_SECRET: 'whsec_test_secret',
  PADDLE_PRICE_IDS_JSON: '{"starter-monthly":"pri_starter_monthly","starter-yearly":"pri_starter_yearly","pro-monthly":"pri_pro_monthly","pro-yearly":"pri_pro_yearly","advanced-monthly":"pri_advanced_monthly","advanced-yearly":"pri_advanced_yearly"}',
  PADDLE_CHECKOUT_SUCCESS_URL: 'http://localhost:3000/billing/success',
  PADDLE_CHECKOUT_CANCEL_URL: 'http://localhost:3000/billing/cancel',
};

function withAuth(overrides: Record<string, string>): Record<string, string> {
  return { ...AUTH_BASE, ...overrides };
}

describe('config loading', () => {
  it('loads valid local defaults', () => {
    const config = loadConfig(withAuth({ APP_ENV: 'local' }));
    expect(config.env).toBe('local');
    expect(config.apiVersion).toBe('v1');
    expect(config.allowedOrigins.length).toBeGreaterThan(0);
    expect(config.auth.provider).toBe('supabase');
    expect(config.billing.paddleEnv).toBe('sandbox');
  });

  it('requires explicit origins outside local', () => {
    expect(() => loadConfig(withAuth({ APP_ENV: 'production' }))).toThrowError(/ALLOWED_ORIGINS/);
  });

  it('accepts comma-separated origins', () => {
    const config = loadConfig(withAuth({
      APP_ENV: 'staging',
      ALLOWED_ORIGINS: 'https://staging.businessflow.app,chrome-extension://abc123',
      API_VERSION: 'v1',
      LOG_LEVEL: 'info',
      PADDLE_CHECKOUT_SUCCESS_URL: 'https://staging.businessflow.app/billing/success',
      PADDLE_CHECKOUT_CANCEL_URL: 'https://staging.businessflow.app/billing/cancel',
    }));

    expect(config.allowedOrigins).toEqual([
      'https://staging.businessflow.app',
      'chrome-extension://abc123',
    ]);
  });

  it('fails when auth credentials are missing', () => {
    expect(() => loadConfig({ APP_ENV: 'local' })).toThrowError(/SUPABASE_URL/);
  });

  it('rejects insecure/non-https origins outside local', () => {
    expect(() => loadConfig(withAuth({
      APP_ENV: 'production',
      ALLOWED_ORIGINS: 'http://localhost:3000,https://businessflow.app',
      PADDLE_CHECKOUT_SUCCESS_URL: 'https://businessflow.app/billing/success',
      PADDLE_CHECKOUT_CANCEL_URL: 'https://businessflow.app/billing/cancel',
    }))).toThrowError(/ALLOWED_ORIGINS/);

    expect(() => loadConfig(withAuth({
      APP_ENV: 'staging',
      ALLOWED_ORIGINS: 'http://staging.businessflow.app',
      PADDLE_CHECKOUT_SUCCESS_URL: 'https://staging.businessflow.app/billing/success',
      PADDLE_CHECKOUT_CANCEL_URL: 'https://staging.businessflow.app/billing/cancel',
    }))).toThrowError(/ALLOWED_ORIGINS/);
  });

  it('rejects non-sandbox client token', () => {
    expect(() => loadConfig(withAuth({
      APP_ENV: 'local',
      PADDLE_CLIENT_TOKEN: 'live_bad_token',
    }))).toThrowError(/PADDLE_CLIENT_TOKEN/);
  });

  it('accepts config with only pro tier price IDs', () => {
    const config = loadConfig(withAuth({
      APP_ENV: 'local',
      PADDLE_PRICE_IDS_JSON: '{"pro-monthly":"pri_pro_m","pro-yearly":"pri_pro_y"}',
    }));
    expect(config.billing.paddlePriceIds).toEqual({
      'pro-monthly': 'pri_pro_m',
      'pro-yearly': 'pri_pro_y',
    });
  });
});
