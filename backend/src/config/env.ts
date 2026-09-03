import { ApiError } from '../errors/api-error.js';
import type { AppEnvironment, EnvBindings } from '../types.js';

export interface AppConfig {
  env: AppEnvironment;
  apiVersion: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  allowedOrigins: string[];
  auth: {
    provider: 'supabase';
    supabaseUrl: string;
    supabaseAnonKey: string;
    supabasePublishableKey: string;
    supabaseSecretKey: string;
    supabaseJwksUrl: string;
    sessionCookieName: string;
    sessionTtlSeconds: number;
    sessionEncryptionKey: string;
  };
  billing: {
    paddleEnv: 'sandbox';
    paddleClientToken: string;
    paddleApiBaseUrl: string;
    paddleApiKey: string;
    paddleWebhookSecret: string;
    paddlePriceIds: Record<string, string>;
    paddleProductIds: Record<string, string>;
    checkoutSuccessUrl: string;
    checkoutCancelUrl: string;
  };
  entitlement: {
    refreshIntervalSeconds: number;
    cacheMaxAgeSeconds: number;
    offlineGraceSeconds: number;
  };
}

const DEFAULT_LOCAL_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
];

const REQUIRED_PRICE_KEYS = [
  'pro-monthly',
  'pro-yearly',
] as const;

function parseEnv(value: string | undefined): AppEnvironment {
  if (!value) return 'local';
  if (value === 'local' || value === 'staging' || value === 'production') return value;
  throw new ApiError({
    code: 'CONFIG_INVALID_APP_ENV',
    status: 500,
    message: 'APP_ENV must be local, staging, or production',
    details: { received: value },
  });
}

function parseLogLevel(value: string | undefined): AppConfig['logLevel'] {
  if (!value) return 'info';
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value;
  throw new ApiError({
    code: 'CONFIG_INVALID_LOG_LEVEL',
    status: 500,
    message: 'LOG_LEVEL must be debug, info, warn, or error',
    details: { received: value },
  });
}

function parseAllowedOrigins(raw: string | undefined, env: AppEnvironment): string[] {
  if (!raw || raw.trim().length === 0) {
    if (env === 'local') return DEFAULT_LOCAL_ORIGINS;
    throw new ApiError({
      code: 'CONFIG_MISSING_ALLOWED_ORIGINS',
      status: 500,
      message: 'ALLOWED_ORIGINS is required outside local environment',
    });
  }

  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new ApiError({
        code: 'CONFIG_INVALID_ALLOWED_ORIGINS',
        status: 500,
        message: 'ALLOWED_ORIGINS contains an invalid origin',
        details: { origin },
      });
    }

    if (env === 'local') continue;

    const isChromeExtension = parsed.protocol === 'chrome-extension:';
    const isHttps = parsed.protocol === 'https:';
    if (!isChromeExtension && !isHttps) {
      throw new ApiError({
        code: 'CONFIG_INVALID_ALLOWED_ORIGINS',
        status: 500,
        message: 'Non-local ALLOWED_ORIGINS must use https:// or chrome-extension://',
        details: { origin },
      });
    }

    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      throw new ApiError({
        code: 'CONFIG_INVALID_ALLOWED_ORIGINS',
        status: 500,
        message: 'Non-local ALLOWED_ORIGINS cannot include localhost',
        details: { origin },
      });
    }
  }

  return origins;
}

function required(name: string, value: string | undefined): string {
  const normalized = value?.trim();
  if (normalized) return normalized;
  throw new ApiError({
    code: `CONFIG_MISSING_${name}`,
    status: 500,
    message: `${name} is required`,
  });
}

function parsePositiveInt(name: string, value: string | undefined, fallback: number): number {
  if (!value || value.trim().length === 0) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ApiError({
      code: `CONFIG_INVALID_${name}`,
      status: 500,
      message: `${name} must be a positive integer`,
    });
  }
  return parsed;
}

function parseJsonRecord(name: string, value: string | undefined, fallback: Record<string, string> = {}): Record<string, string> {
  if (!value || value.trim().length === 0) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ApiError({
      code: `CONFIG_INVALID_${name}`,
      status: 500,
      message: `${name} must be valid JSON`,
    });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError({
      code: `CONFIG_INVALID_${name}`,
      status: 500,
      message: `${name} must be a JSON object`,
    });
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  const out: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new ApiError({
        code: `CONFIG_INVALID_${name}`,
        status: 500,
        message: `${name} values must be non-empty strings`,
      });
    }
    out[key] = raw.trim();
  }
  return out;
}

function parsePaddleClientToken(value: string | undefined): string {
  const token = required('PADDLE_CLIENT_TOKEN', value);
  if (!token.startsWith('test_')) {
    throw new ApiError({
      code: 'CONFIG_INVALID_PADDLE_CLIENT_TOKEN',
      status: 500,
      message: 'PADDLE_CLIENT_TOKEN must be a sandbox test_ token',
    });
  }
  return token;
}

function validateRequiredPriceKeys(priceMap: Record<string, string>): void {
  const missing = REQUIRED_PRICE_KEYS.filter((key) => !priceMap[key]);
  if (missing.length === 0) return;
  throw new ApiError({
    code: 'CONFIG_INVALID_PADDLE_PRICE_IDS_JSON',
    status: 500,
    message: `PADDLE_PRICE_IDS_JSON is missing required keys: ${missing.join(', ')}`,
  });
}

function parseAbsoluteUrl(name: string, value: string | undefined, env: AppEnvironment): string {
  const raw = required(name, value);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ApiError({
      code: `CONFIG_INVALID_${name}`,
      status: 500,
      message: `${name} must be a valid absolute URL`,
    });
  }

  if (env !== 'local' && parsed.protocol !== 'https:') {
    throw new ApiError({
      code: `CONFIG_INVALID_${name}`,
      status: 500,
      message: `${name} must use https outside local environment`,
    });
  }

  return parsed.toString();
}

export function loadConfig(envBindings: EnvBindings): AppConfig {
  const env = parseEnv(envBindings.APP_ENV);
  const apiVersion = envBindings.API_VERSION?.trim() || 'v1';
  const logLevel = parseLogLevel(envBindings.LOG_LEVEL);
  const allowedOrigins = parseAllowedOrigins(envBindings.ALLOWED_ORIGINS, env);

  const provider = envBindings.AUTH_PROVIDER?.trim() || 'supabase';
  if (provider !== 'supabase') {
    throw new ApiError({
      code: 'CONFIG_INVALID_AUTH_PROVIDER',
      status: 500,
      message: 'AUTH_PROVIDER must be supabase',
    });
  }

  const supabaseUrl = required('SUPABASE_URL', envBindings.SUPABASE_URL);
  const supabaseAnonKey = required('SUPABASE_ANON_KEY', envBindings.SUPABASE_ANON_KEY);
  // SUPABASE_PUBLISHABLE_KEY is the new name for the anon/publishable key in @supabase/server.
  // Falls back to SUPABASE_ANON_KEY for backward compatibility.
  const supabasePublishableKey = envBindings.SUPABASE_PUBLISHABLE_KEY?.trim() || supabaseAnonKey;
  const supabaseSecretKey = required('SUPABASE_SECRET_KEY', envBindings.SUPABASE_SECRET_KEY);
  const supabaseJwksUrl = required('SUPABASE_JWKS_URL', envBindings.SUPABASE_JWKS_URL);
  const sessionEncryptionKey = required('SESSION_ENCRYPTION_KEY', envBindings.SESSION_ENCRYPTION_KEY);

  const paddleEnv = envBindings.PADDLE_ENV?.trim() || 'sandbox';
  if (paddleEnv !== 'sandbox') {
    throw new ApiError({
      code: 'CONFIG_INVALID_PADDLE_ENV',
      status: 500,
      message: 'PADDLE_ENV must be sandbox for this phase',
    });
  }

  const paddlePriceIds = parseJsonRecord('PADDLE_PRICE_IDS_JSON', envBindings.PADDLE_PRICE_IDS_JSON);
  if (Object.keys(paddlePriceIds).length === 0) {
    throw new ApiError({
      code: 'CONFIG_MISSING_PADDLE_PRICE_IDS_JSON',
      status: 500,
      message: 'PADDLE_PRICE_IDS_JSON must define at least one plan->price mapping',
    });
  }
  validateRequiredPriceKeys(paddlePriceIds);
  const paddleClientToken = parsePaddleClientToken(envBindings.PADDLE_CLIENT_TOKEN);

  return {
    env,
    apiVersion,
    logLevel,
    allowedOrigins,
    auth: {
      provider: 'supabase',
      supabaseUrl,
      supabaseAnonKey,
      supabasePublishableKey,
      supabaseSecretKey,
      supabaseJwksUrl,
      sessionCookieName: envBindings.SESSION_COOKIE_NAME?.trim() || 'bf_session',
      sessionTtlSeconds: parsePositiveInt('SESSION_TTL_SECONDS', envBindings.SESSION_TTL_SECONDS, 60 * 60 * 24 * 30),
      sessionEncryptionKey,
    },
    billing: {
      paddleEnv: 'sandbox',
      paddleClientToken,
      paddleApiBaseUrl: envBindings.PADDLE_API_BASE_URL?.trim() || 'https://sandbox-api.paddle.com',
      paddleApiKey: required('PADDLE_API_KEY', envBindings.PADDLE_API_KEY),
      paddleWebhookSecret: required('PADDLE_WEBHOOK_SECRET', envBindings.PADDLE_WEBHOOK_SECRET),
      paddlePriceIds,
      paddleProductIds: parseJsonRecord('PADDLE_PRODUCT_IDS_JSON', envBindings.PADDLE_PRODUCT_IDS_JSON, {}),
      checkoutSuccessUrl: parseAbsoluteUrl('PADDLE_CHECKOUT_SUCCESS_URL', envBindings.PADDLE_CHECKOUT_SUCCESS_URL, env),
      checkoutCancelUrl: parseAbsoluteUrl('PADDLE_CHECKOUT_CANCEL_URL', envBindings.PADDLE_CHECKOUT_CANCEL_URL, env),
    },
    entitlement: {
      refreshIntervalSeconds: parsePositiveInt('ENTITLEMENT_REFRESH_INTERVAL_SECONDS', envBindings.ENTITLEMENT_REFRESH_INTERVAL_SECONDS, 300),
      cacheMaxAgeSeconds: parsePositiveInt('ENTITLEMENT_CACHE_MAX_AGE_SECONDS', envBindings.ENTITLEMENT_CACHE_MAX_AGE_SECONDS, 900),
      offlineGraceSeconds: parsePositiveInt('ENTITLEMENT_OFFLINE_GRACE_SECONDS', envBindings.ENTITLEMENT_OFFLINE_GRACE_SECONDS, 900),
    },
  };
}
