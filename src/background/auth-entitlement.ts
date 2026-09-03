import type { AuthStatusPayload, EntitlementPayload, ExtensionAccessState } from '../core/auth.js';
import type { BillingCatalogPayload, BillingCheckoutPayload, BillingPortalPayload } from '../core/billing.js';

interface StoredAuthSession {
  token: string;
  userId: string;
  email: string;
  expiresAt: number;
}

interface StoredEntitlementCache {
  payload: EntitlementPayload;
  fetchedAtMs: number;
  stale: boolean;
  lastError: string | null;
}

interface StoredAuthConfig {
  backendBaseUrl: string;
}

interface StorageShape {
  session: StoredAuthSession | null;
  entitlement: StoredEntitlementCache | null;
  config: StoredAuthConfig;
  sessionExpired: boolean;
}

interface StoragePort {
  read: () => Promise<StorageShape>;
  write: (next: Partial<StorageShape>) => Promise<void>;
  clearAuth: () => Promise<void>;
}

interface FetchPort {
  send: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

interface ManagerDependencies {
  storage: StoragePort;
  fetcher: FetchPort;
  now: () => number;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: {
    code?: string;
    message?: string;
  };
}

interface ExtensionLoginResponse {
  user: {
    userId: string;
    email: string;
  };
  sessionToken: string;
  expiresInSeconds: number;
}

const DEFAULT_BASE_URL = 'http://localhost:8787';

const STORAGE_KEYS = {
  session: 'bf:auth:session',
  entitlement: 'bf:auth:entitlement',
  config: 'bf:auth:config',
  sessionExpired: 'bf:auth:session-expired',
} as const;

function safeTrim(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isLocalDevHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

function isAllowedBusinessflowHost(hostname: string): boolean {
  return hostname === 'businessflow.app'
    || hostname.endsWith('.businessflow.app')
    || hostname === 'businessflow.local'
    || hostname.endsWith('.businessflow.local');
}

function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return DEFAULT_BASE_URL;
  const parsed = new URL(trimmed);

  if (parsed.protocol === 'http:') {
    if (!isLocalDevHost(parsed.hostname)) {
      throw new Error('HTTP backend URL is allowed only for localhost/127.0.0.1');
    }
  } else if (parsed.protocol === 'https:') {
    if (!isLocalDevHost(parsed.hostname) && !isAllowedBusinessflowHost(parsed.hostname)) {
      throw new Error('Backend URL must be a BusinessFlow domain');
    }
  } else {
    throw new Error('Backend URL must use http or https');
  }

  return parsed.origin;
}

function mapAccessStateFromEntitlement(payload: EntitlementPayload, stale: boolean): {
  state: ExtensionAccessState;
  message: string;
} {
  if (!payload.access.granted) {
    const reason = payload.access.state === 'free'
      ? 'Access unavailable: your account is on the free plan.'
      : payload.access.state === 'revoked'
        ? 'Access unavailable: account access has been revoked.'
        : payload.access.state === 'past_due'
          ? 'Access unavailable: billing is past due.'
          : payload.access.state === 'expired'
            ? 'Access unavailable: subscription expired.'
            : payload.access.state === 'paused'
              ? 'Access unavailable: subscription is paused.'
              : 'Access unavailable.';

    return {
      state: 'access_unavailable',
      message: stale ? `${reason} Showing cached result while offline.` : reason,
    };
  }

  return {
    state: 'access_active',
    message: stale ? 'Access active (cached while backend unavailable).' : 'Access active.',
  };
}

function toStatus(shape: StorageShape, nowMs: number): AuthStatusPayload {
  if (shape.sessionExpired) {
    return {
      state: 'session_expired',
      backendBaseUrl: shape.config.backendBaseUrl,
      signedIn: false,
      user: null,
      entitlement: null,
      message: 'Session expired. Please sign in again.',
      checkedAt: new Date(nowMs).toISOString(),
    };
  }

  if (!shape.session) {
    return {
      state: 'signed_out',
      backendBaseUrl: shape.config.backendBaseUrl,
      signedIn: false,
      user: null,
      entitlement: null,
      message: 'Signed out.',
      checkedAt: new Date(nowMs).toISOString(),
    };
  }

  const user = {
    userId: shape.session.userId,
    email: shape.session.email,
  };

  if (!shape.entitlement) {
    return {
      state: 'signed_in',
      backendBaseUrl: shape.config.backendBaseUrl,
      signedIn: true,
      user,
      entitlement: null,
      message: 'Signed in. Checking access…',
      checkedAt: new Date(nowMs).toISOString(),
    };
  }

  const mapped = mapAccessStateFromEntitlement(shape.entitlement.payload, shape.entitlement.stale);
  return {
    state: mapped.state,
    backendBaseUrl: shape.config.backendBaseUrl,
    signedIn: true,
    user,
    entitlement: {
      plan: shape.entitlement.payload.plan,
      granted: shape.entitlement.payload.access.granted,
      state: shape.entitlement.payload.access.state,
      accessUntil: shape.entitlement.payload.access.accessUntil,
      checkedAt: shape.entitlement.payload.authorization.checkedAt,
      entitlementVersion: shape.entitlement.payload.entitlementVersion,
      stale: shape.entitlement.stale,
    },
    message: mapped.message,
    checkedAt: new Date(nowMs).toISOString(),
  };
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const payload = await response.json() as ApiEnvelope<T>;
  if (!response.ok || !payload.success || !payload.data) {
    const message = payload.error?.message || `Request failed with status ${response.status}`;
    const error = new Error(message);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return payload.data;
}

let refreshInFlight: Promise<AuthStatusPayload> | null = null;

export function createAuthEntitlementManager(deps: ManagerDependencies) {
  async function getStorage(): Promise<StorageShape> {
    return deps.storage.read();
  }

  async function setBackendBaseUrl(input: string): Promise<AuthStatusPayload> {
    const backendBaseUrl = normalizeBaseUrl(input);
    await deps.storage.write({
      config: { backendBaseUrl },
    });
    const latest = await getStorage();
    return toStatus(latest, deps.now());
  }

  async function signIn(email: string, password: string): Promise<AuthStatusPayload> {
    const trimmedEmail = safeTrim(email);
    if (!trimmedEmail || !password) {
      throw new Error('Email and password are required');
    }

    const shape = await getStorage();
    const loginResponse = await deps.fetcher.send(`${shape.config.backendBaseUrl}/api/v1/auth/extension/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: trimmedEmail,
        password,
      }),
    });

    const data = await parseApiResponse<ExtensionLoginResponse>(loginResponse);

    await deps.storage.write({
      session: {
        token: data.sessionToken,
        userId: data.user.userId,
        email: data.user.email,
        expiresAt: deps.now() + data.expiresInSeconds * 1000,
      },
      sessionExpired: false,
    });

    return refreshEntitlement(true);
  }

  async function signUp(email: string, password: string): Promise<AuthStatusPayload> {
    const trimmedEmail = safeTrim(email);
    if (!trimmedEmail || !password) {
      throw new Error('Email and password are required');
    }

    const shape = await getStorage();
    const signupResponse = await deps.fetcher.send(`${shape.config.backendBaseUrl}/api/v1/auth/signup`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: trimmedEmail,
        password,
      }),
    });

    await parseApiResponse<{ user: { userId: string; email: string } }>(signupResponse);
    return signIn(trimmedEmail, password);
  }

  async function signOut(): Promise<AuthStatusPayload> {
    const shape = await getStorage();
    if (shape.session?.token) {
      await deps.fetcher.send(`${shape.config.backendBaseUrl}/api/v1/auth/extension/logout`, {
        method: 'POST',
        headers: {
          authorization: `Session ${shape.session.token}`,
        },
      }).catch(() => undefined);
    }

    await deps.storage.clearAuth();
    const cleared = await getStorage();
    return toStatus(cleared, deps.now());
  }

  async function refreshEntitlement(force = false): Promise<AuthStatusPayload> {
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
      const shape = await getStorage();
      if (!shape.session) {
        return toStatus(shape, deps.now());
      }

      const nowMs = deps.now();
      const cache = shape.entitlement;

      if (!force && cache) {
        const refreshAfterMs = cache.payload.authorization.refreshAfterSeconds * 1000;
        if (nowMs - cache.fetchedAtMs < refreshAfterMs) {
          return toStatus(shape, nowMs);
        }
      }

      try {
        const response = await deps.fetcher.send(`${shape.config.backendBaseUrl}/api/v1/entitlement`, {
          method: 'GET',
          headers: {
            authorization: `Session ${shape.session.token}`,
          },
        });

        if (response.status === 401) {
          await deps.storage.clearAuth();
          await deps.storage.write({ sessionExpired: true });
          const expired = await getStorage();
          return toStatus(expired, deps.now());
        }

        const payload = await parseApiResponse<EntitlementPayload>(response);
        await deps.storage.write({
          entitlement: {
            payload,
            fetchedAtMs: nowMs,
            stale: false,
            lastError: null,
          },
          sessionExpired: false,
        });

        const updated = await getStorage();
        return toStatus(updated, deps.now());
      } catch (error) {
        const latest = await getStorage();
        const cached = latest.entitlement;
        if (cached) {
          const ageMs = deps.now() - cached.fetchedAtMs;
          const maxAgeMs = cached.payload.authorization.cacheMaxAgeSeconds * 1000;
          const graceMs = cached.payload.authorization.offlineGraceSeconds * 1000;
          if (ageMs <= maxAgeMs + graceMs) {
            await deps.storage.write({
              entitlement: {
                ...cached,
                stale: true,
                lastError: error instanceof Error ? error.message : String(error),
              },
            });
            const stale = await getStorage();
            return toStatus(stale, deps.now());
          }
        }

        await deps.storage.write({
          entitlement: cached
            ? {
                ...cached,
                stale: true,
                lastError: error instanceof Error ? error.message : String(error),
              }
            : null,
        });

        const fallback = await getStorage();
        const base = toStatus(fallback, deps.now());
        return {
          ...base,
          state: 'access_unavailable',
          message: 'Access unavailable: unable to verify entitlement with backend.',
        };
      }
    })();

    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  async function getStatus(refreshIfNeeded = true): Promise<AuthStatusPayload> {
    if (!refreshIfNeeded) {
      const latest = await getStorage();
      return toStatus(latest, deps.now());
    }
    return refreshEntitlement(false);
  }

  async function bootstrapOnStartup(): Promise<void> {
    const shape = await getStorage();
    if (!shape.session) return;
    await refreshEntitlement(false);
  }

  async function getBillingCatalog(): Promise<BillingCatalogPayload> {
    const shape = await getStorage();
    const response = await deps.fetcher.send(`${shape.config.backendBaseUrl}/api/v1/billing/catalog`, {
      method: 'GET',
    });
    return parseApiResponse<BillingCatalogPayload>(response);
  }

  async function createCheckout(planKey: string): Promise<BillingCheckoutPayload> {
    const trimmedPlanKey = safeTrim(planKey);
    if (!trimmedPlanKey) throw new Error('planKey is required');

    const shape = await getStorage();
    if (!shape.session) {
      throw new Error('Sign in required before checkout');
    }

    const response = await deps.fetcher.send(`${shape.config.backendBaseUrl}/api/v1/billing/checkout`, {
      method: 'POST',
      headers: {
        authorization: `Session ${shape.session.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ planKey: trimmedPlanKey }),
    });

    return parseApiResponse<BillingCheckoutPayload>(response);
  }

  async function createCustomerPortal(): Promise<BillingPortalPayload> {
    const shape = await getStorage();
    if (!shape.session) {
      throw new Error('Sign in required before opening billing portal');
    }

    const response = await deps.fetcher.send(`${shape.config.backendBaseUrl}/api/v1/billing/portal`, {
      method: 'POST',
      headers: {
        authorization: `Session ${shape.session.token}`,
      },
    });

    return parseApiResponse<BillingPortalPayload>(response);
  }

  return {
    setBackendBaseUrl,
    signIn,
    signUp,
    signOut,
    refreshEntitlement,
    getStatus,
    bootstrapOnStartup,
    getBillingCatalog,
    createCheckout,
    createCustomerPortal,
  };
}

export function createChromeStoragePort(): StoragePort {
  return {
    async read(): Promise<StorageShape> {
      const raw = await chrome.storage.local.get([
        STORAGE_KEYS.session,
        STORAGE_KEYS.entitlement,
        STORAGE_KEYS.config,
        STORAGE_KEYS.sessionExpired,
      ]);

      const configRaw = raw[STORAGE_KEYS.config];
      const config = (configRaw && typeof configRaw === 'object' && !Array.isArray(configRaw))
        ? configRaw as StoredAuthConfig
        : { backendBaseUrl: DEFAULT_BASE_URL };

      const sessionRaw = raw[STORAGE_KEYS.session];
      const entitlementRaw = raw[STORAGE_KEYS.entitlement];

      return {
        session: (sessionRaw && typeof sessionRaw === 'object' && !Array.isArray(sessionRaw))
          ? sessionRaw as StoredAuthSession
          : null,
        entitlement: (entitlementRaw && typeof entitlementRaw === 'object' && !Array.isArray(entitlementRaw))
          ? entitlementRaw as StoredEntitlementCache
          : null,
        config: {
          backendBaseUrl: safeTrim(config.backendBaseUrl) || DEFAULT_BASE_URL,
        },
        sessionExpired: Boolean(raw[STORAGE_KEYS.sessionExpired]),
      };
    },
    async write(next: Partial<StorageShape>): Promise<void> {
      const patch: Record<string, unknown> = {};
      if (next.session !== undefined) patch[STORAGE_KEYS.session] = next.session;
      if (next.entitlement !== undefined) patch[STORAGE_KEYS.entitlement] = next.entitlement;
      if (next.config !== undefined) patch[STORAGE_KEYS.config] = next.config;
      if (next.sessionExpired !== undefined) patch[STORAGE_KEYS.sessionExpired] = next.sessionExpired;
      await chrome.storage.local.set(patch);
    },
    async clearAuth(): Promise<void> {
      await chrome.storage.local.remove([
        STORAGE_KEYS.session,
        STORAGE_KEYS.entitlement,
        STORAGE_KEYS.sessionExpired,
      ]);
    },
  };
}

export function createChromeAuthEntitlementManager() {
  return createAuthEntitlementManager({
    storage: createChromeStoragePort(),
    fetcher: { send: (input, init) => fetch(input, init) },
    now: () => Date.now(),
  });
}
