export type AppEnvironment = 'local' | 'staging' | 'production';

export interface EnvBindings {
  APP_ENV?: string;
  API_VERSION?: string;
  LOG_LEVEL?: string;
  ALLOWED_ORIGINS?: string;
  AUTH_PROVIDER?: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SESSION_COOKIE_NAME?: string;
  SESSION_TTL_SECONDS?: string;
  SESSION_ENCRYPTION_KEY?: string;
  PADDLE_ENV?: string;
  PADDLE_API_BASE_URL?: string;
  PADDLE_API_KEY?: string;
  PADDLE_CLIENT_TOKEN?: string;
  PADDLE_WEBHOOK_SECRET?: string;
  PADDLE_PRICE_IDS_JSON?: string;
  PADDLE_PRODUCT_IDS_JSON?: string;
  PADDLE_CHECKOUT_SUCCESS_URL?: string;
  PADDLE_CHECKOUT_CANCEL_URL?: string;
  ENTITLEMENT_REFRESH_INTERVAL_SECONDS?: string;
  ENTITLEMENT_CACHE_MAX_AGE_SECONDS?: string;
  ENTITLEMENT_OFFLINE_GRACE_SECONDS?: string;
  DB?: D1Database;
}

export interface RequestContext {
  requestId: string;
  startedAt: number;
}

export interface AuthContext {
  actorType: 'anonymous' | 'session' | 'bearer';
  sessionToken?: string;
  bearerToken?: string;
}

export interface AuthenticatedIdentity {
  userId: string;
  providerUserId: string;
  email: string;
  sessionId: string;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  requestId: string;
}

export interface ApiErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId: string;
}
