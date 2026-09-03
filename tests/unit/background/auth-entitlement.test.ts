import { describe, expect, it } from 'vitest';
import type { EntitlementPayload } from '../../../src/core/auth.js';
import { createAuthEntitlementManager } from '../../../src/background/auth-entitlement.js';

interface InMemoryShape {
  session: { token: string; userId: string; email: string; expiresAt: number } | null;
  entitlement: {
    payload: EntitlementPayload;
    fetchedAtMs: number;
    stale: boolean;
    lastError: string | null;
  } | null;
  config: { backendBaseUrl: string };
  sessionExpired: boolean;
}

function makeEntitlement(state: string, granted: boolean, checkedAt = new Date().toISOString()): EntitlementPayload {
  return {
    userId: 'user_1',
    plan: granted ? 'pro-monthly' : 'free',
    access: {
      granted,
      state,
      accessUntil: granted ? new Date(Date.now() + 3600_000).toISOString() : null,
    },
    authorization: {
      checkedAt,
      refreshAfterSeconds: 60,
      cacheMaxAgeSeconds: 120,
      offlineGraceSeconds: 120,
    },
    entitlementVersion: `ent_v1_${checkedAt}`,
  };
}

function setupHarness() {
  const shape: InMemoryShape = {
    session: null,
    entitlement: null,
    config: { backendBaseUrl: 'https://api.businessflow.local' },
    sessionExpired: false,
  };

  let nowMs = Date.parse('2026-03-01T00:00:00.000Z');
  let mode: 'paid' | 'free' | 'expired' | 'revoked' | 'past_due' = 'paid';
  let backendUnavailable = false;
  let unauthorized = false;

  const send = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (backendUnavailable) {
      throw new Error('network down');
    }

    if (url.endsWith('/api/v1/auth/signup')) {
      const body = JSON.parse(String(init?.body || '{}')) as { email?: string; password?: string };
      if (!body.email || !body.password || body.password.length < 8) {
        return new Response(JSON.stringify({ success: false, error: { message: 'invalid signup payload' } }), { status: 400 });
      }
      if (body.email === 'exists@businessflow.dev') {
        return new Response(JSON.stringify({ success: false, error: { message: 'already registered' } }), { status: 409 });
      }
      return new Response(JSON.stringify({
        success: true,
        data: {
          user: { userId: 'user_1', email: body.email },
        },
      }), { status: 201 });
    }

    if (url.endsWith('/api/v1/auth/extension/login')) {
      const body = JSON.parse(String(init?.body || '{}')) as { email?: string; password?: string };
      if (!body.email || !body.password || body.password !== 'Password123!') {
        return new Response(JSON.stringify({ success: false, error: { message: 'invalid credentials' } }), { status: 401 });
      }

      return new Response(JSON.stringify({
        success: true,
        data: {
          user: { userId: 'user_1', email: body.email },
          sessionToken: 'sess_token_123',
          expiresInSeconds: 3600,
        },
      }), { status: 200 });
    }

    if (url.endsWith('/api/v1/auth/extension/logout')) {
      return new Response(JSON.stringify({ success: true, data: { loggedOut: true } }), { status: 200 });
    }

    if (url.endsWith('/api/v1/entitlement')) {
      if (unauthorized) {
        return new Response(JSON.stringify({ success: false, error: { message: 'unauthorized' } }), { status: 401 });
      }

      const payload = mode === 'paid'
        ? makeEntitlement('paid_active', true, new Date(nowMs).toISOString())
        : mode === 'free'
          ? makeEntitlement('free', false, new Date(nowMs).toISOString())
          : mode === 'expired'
            ? {
                ...makeEntitlement('expired', false, new Date(nowMs).toISOString()),
                plan: 'pro-monthly',
                access: {
                  granted: false,
                  state: 'expired',
                  accessUntil: new Date(nowMs - 3600_000).toISOString(),
                },
              }
            : mode === 'revoked'
              ? {
                  ...makeEntitlement('revoked', false, new Date(nowMs).toISOString()),
                  plan: 'pro-monthly',
                  access: {
                    granted: false,
                    state: 'revoked',
                    accessUntil: null,
                  },
                }
              : {
                  ...makeEntitlement('past_due', false, new Date(nowMs).toISOString()),
                  plan: 'pro-monthly',
                  access: {
                    granted: false,
                    state: 'past_due',
                    accessUntil: null,
                  },
                };

      return new Response(JSON.stringify({ success: true, data: payload }), { status: 200 });
    }

    return new Response(JSON.stringify({ success: false, error: { message: 'not found' } }), { status: 404 });
  };

  const manager = createAuthEntitlementManager({
    storage: {
      async read() {
        return {
          session: shape.session,
          entitlement: shape.entitlement,
          config: shape.config,
          sessionExpired: shape.sessionExpired,
        };
      },
      async write(next) {
        if (next.session !== undefined) shape.session = next.session;
        if (next.entitlement !== undefined) shape.entitlement = next.entitlement;
        if (next.config !== undefined) shape.config = next.config;
        if (next.sessionExpired !== undefined) shape.sessionExpired = next.sessionExpired;
      },
      async clearAuth() {
        shape.session = null;
        shape.entitlement = null;
        shape.sessionExpired = false;
      },
    },
    fetcher: {
      send,
    },
    now: () => nowMs,
  });

  return {
    manager,
    send,
    setNow(next: string) { nowMs = Date.parse(next); },
    setMode(next: typeof mode) { mode = next; },
    setBackendUnavailable(next: boolean) { backendUnavailable = next; },
    setUnauthorized(next: boolean) { unauthorized = next; },
    shape,
  };
}

describe('extension auth entitlement manager', () => {
  it('supports login and successful paid entitlement', async () => {
    const h = setupHarness();
    const status = await h.manager.signIn('qa@businessflow.dev', 'Password123!');
    expect(status.state).toBe('access_active');
    expect(status.signedIn).toBe(true);
    expect(status.entitlement?.granted).toBe(true);
  });

  it('supports sign-up then immediate signed-in entitlement check', async () => {
    const h = setupHarness();
    const status = await h.manager.signUp('new@businessflow.dev', 'Password123!');
    expect(status.signedIn).toBe(true);
    expect(status.state).toBe('access_active');
  });

  it('supports logout cleanly', async () => {
    const h = setupHarness();
    await h.manager.signIn('qa@businessflow.dev', 'Password123!');
    const status = await h.manager.signOut();
    expect(status.state).toBe('signed_out');
    expect(status.signedIn).toBe(false);
  });

  it('handles free account entitlement as access unavailable', async () => {
    const h = setupHarness();
    h.setMode('free');
    const status = await h.manager.signIn('free@businessflow.dev', 'Password123!');
    expect(status.state).toBe('access_unavailable');
    expect(status.entitlement?.state).toBe('free');
  });

  it('handles expired subscription state', async () => {
    const h = setupHarness();
    h.setMode('expired');
    const status = await h.manager.signIn('expired@businessflow.dev', 'Password123!');
    expect(status.state).toBe('access_unavailable');
    expect(status.entitlement?.state).toBe('expired');
  });

  it('handles revoked access state', async () => {
    const h = setupHarness();
    h.setMode('revoked');
    const status = await h.manager.signIn('revoked@businessflow.dev', 'Password123!');
    expect(status.state).toBe('access_unavailable');
    expect(status.entitlement?.state).toBe('revoked');
  });

  it('handles session expiration from backend', async () => {
    const h = setupHarness();
    await h.manager.signIn('expired-session@businessflow.dev', 'Password123!');
    h.setUnauthorized(true);
    const status = await h.manager.refreshEntitlement(true);
    expect(status.state).toBe('session_expired');
    expect(status.signedIn).toBe(false);
  });

  it('handles backend unavailable with conservative stale policy', async () => {
    const h = setupHarness();
    await h.manager.signIn('offline@businessflow.dev', 'Password123!');
    h.setBackendUnavailable(true);

    h.setNow('2026-03-01T00:02:00.000Z');
    const graceStatus = await h.manager.refreshEntitlement(true);
    expect(graceStatus.state).toBe('access_active');
    expect(graceStatus.entitlement?.stale).toBe(true);

    h.setNow('2026-03-01T00:10:00.000Z');
    const expiredGraceStatus = await h.manager.refreshEntitlement(true);
    expect(expiredGraceStatus.state).toBe('access_unavailable');
  });

  it('supports repeated sign-in/sign-out cycles', async () => {
    const h = setupHarness();
    for (let index = 0; index < 3; index += 1) {
      const signedIn = await h.manager.signIn(`repeat${index}@businessflow.dev`, 'Password123!');
      expect(signedIn.signedIn).toBe(true);
      const signedOut = await h.manager.signOut();
      expect(signedOut.signedIn).toBe(false);
    }
  });

  it('survives extension/browser restart via persisted storage', async () => {
    const h = setupHarness();
    await h.manager.signIn('restart@businessflow.dev', 'Password123!');

    const managerAfterRestart = createAuthEntitlementManager({
      storage: {
        read: async () => ({ ...h.shape }),
        write: async (next) => {
          if (next.session !== undefined) h.shape.session = next.session;
          if (next.entitlement !== undefined) h.shape.entitlement = next.entitlement;
          if (next.config !== undefined) h.shape.config = next.config;
          if (next.sessionExpired !== undefined) h.shape.sessionExpired = next.sessionExpired;
        },
        clearAuth: async () => {
          h.shape.session = null;
          h.shape.entitlement = null;
          h.shape.sessionExpired = false;
        },
      },
      fetcher: {
        send: h.send,
      },
      now: () => Date.parse('2026-03-01T00:00:30.000Z'),
    });

    const status = await managerAfterRestart.getStatus(false);
    expect(status.signedIn).toBe(true);
  });

  it('allows backend URL update and refresh requests', async () => {
    const h = setupHarness();
    const updated = await h.manager.setBackendBaseUrl('https://staging.businessflow.app');
    expect(updated.backendBaseUrl).toBe('https://staging.businessflow.app');

    await h.manager.signIn('refresh@businessflow.dev', 'Password123!');
    h.setMode('past_due');
    const refreshed = await h.manager.refreshEntitlement(true);
    expect(refreshed.entitlement?.state).toBe('past_due');
  });

  it('rejects non-BusinessFlow and insecure backend URLs', async () => {
    const h = setupHarness();
    await expect(h.manager.setBackendBaseUrl('http://evil.example.com')).rejects.toThrow(/HTTP backend URL/);
    await expect(h.manager.setBackendBaseUrl('https://evil.example.com')).rejects.toThrow(/BusinessFlow domain/);

    const local = await h.manager.setBackendBaseUrl('http://localhost:8787');
    expect(local.backendBaseUrl).toBe('http://localhost:8787');
  });
});
