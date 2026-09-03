import { describe, expect, it, beforeEach } from 'vitest';
import { createAuthTestApp, InMemoryAuthRepository, MockAuthProvider } from './auth-test-doubles.js';
import { resetRateLimitStoreForTests } from '../../../backend/src/http/rate-limit.js';
import { readSetCookie } from './helpers.js';

function cookieHeaderFromSetCookie(setCookie: string): string {
  return setCookie.split(';')[0] ?? '';
}

describe('authentication flow', () => {
  beforeEach(() => {
    resetRateLimitStoreForTests();
  });

  it('signup creates session cookie and allows authenticated profile access', async () => {
    const provider = new MockAuthProvider();
    const repository = new InMemoryAuthRepository();
    const { app, env } = createAuthTestApp(provider, repository);

    const signupResponse = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ email: 'qa@businessflow.dev', password: 'Password123!' }),
      }),
      env,
    );

    expect(signupResponse.status).toBe(201);
    const setCookie = readSetCookie(signupResponse);
    expect(setCookie).toContain('bf_session=');
    expect(setCookie).toContain('HttpOnly');

    const meResponse = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/auth/me', {
        method: 'GET',
        headers: {
          cookie: cookieHeaderFromSetCookie(setCookie),
          origin: 'http://localhost:3000',
        },
      }),
      env,
    );

    expect(meResponse.status).toBe(200);
    const meBody = await meResponse.json() as { success: boolean; data: { user: { email: string } } };
    expect(meBody.success).toBe(true);
    expect(meBody.data.user.email).toBe('qa@businessflow.dev');
  });

  it('login works and invalid credentials are rejected', async () => {
    const provider = new MockAuthProvider();
    const repository = new InMemoryAuthRepository();
    const { app, env } = createAuthTestApp(provider, repository);

    await app.fetch(
      new Request('https://api.businessflow.local/api/v1/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'owner@businessflow.dev', password: 'Password123!' }),
      }),
      env,
    );

    const loginSuccess = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'owner@businessflow.dev', password: 'Password123!' }),
      }),
      env,
    );
    expect(loginSuccess.status).toBe(200);

    const loginFailure = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'owner@businessflow.dev', password: 'wrong-pass' }),
      }),
      env,
    );

    expect(loginFailure.status).toBe(401);
    const body = await loginFailure.json() as { error: { code: string } };
    expect(body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('rate limits repeated login abuse attempts', async () => {
    const provider = new MockAuthProvider();
    const repository = new InMemoryAuthRepository();
    const { app, env } = createAuthTestApp(provider, repository);

    await app.fetch(
      new Request('https://api.businessflow.local/api/v1/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.8.0.5' },
        body: JSON.stringify({ email: 'abuse@businessflow.dev', password: 'Password123!' }),
      }),
      env,
    );

    let final: Response | null = null;
    for (let attempt = 0; attempt < 26; attempt += 1) {
      final = await app.fetch(
        new Request('https://api.businessflow.local/api/v1/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.8.0.5' },
          body: JSON.stringify({ email: 'abuse@businessflow.dev', password: 'wrong-pass' }),
        }),
        env,
      );
    }

    if (!final) throw new Error('expected final response');
    expect(final.status).toBe(429);
    const body = await final.json() as { error: { code: string } };
    expect(body.error.code).toBe('RATE_LIMITED');

    const cleanIp = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.8.0.6' },
        body: JSON.stringify({ email: 'abuse@businessflow.dev', password: 'Password123!' }),
      }),
      env,
    );
    expect(cleanIp.status).toBe(200);
  });

  it('logout revokes session and clears cookie', async () => {
    const provider = new MockAuthProvider();
    const repository = new InMemoryAuthRepository();
    const { app, env } = createAuthTestApp(provider, repository);

    const signup = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'logout@businessflow.dev', password: 'Password123!' }),
      }),
      env,
    );

    const sessionCookie = cookieHeaderFromSetCookie(readSetCookie(signup));

    const logout = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/auth/logout', {
        method: 'POST',
        headers: { cookie: sessionCookie },
      }),
      env,
    );

    expect(logout.status).toBe(200);
    expect(readSetCookie(logout)).toContain('Max-Age=0');

    const me = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/auth/me', {
        method: 'GET',
        headers: { cookie: sessionCookie },
      }),
      env,
    );

    expect(me.status).toBe(401);
  });

  it('expired session is rejected and unauthorized access is blocked', async () => {
    const provider = new MockAuthProvider();
    const repository = new InMemoryAuthRepository();
    const { app, env } = createAuthTestApp(provider, repository);

    const signup = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'expired@businessflow.dev', password: 'Password123!' }),
      }),
      env,
    );

    const sessionCookie = cookieHeaderFromSetCookie(readSetCookie(signup));
    const hashEntry = [...repository.sessionsByHash.entries()][0];
    if (!hashEntry) throw new Error('expected session to exist');

    repository.sessionsByHash.set(hashEntry[0], {
      ...hashEntry[1],
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const me = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/auth/me', {
        method: 'GET',
        headers: { cookie: sessionCookie },
      }),
      env,
    );

    expect(me.status).toBe(401);

    const accountUnauthed = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/account', {
        method: 'GET',
      }),
      env,
    );

    expect(accountUnauthed.status).toBe(401);
  });

  it('account endpoint derives ownership from authenticated identity only', async () => {
    const provider = new MockAuthProvider();
    const repository = new InMemoryAuthRepository();
    const { app, env } = createAuthTestApp(provider, repository);

    const signup = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'owner2@businessflow.dev', password: 'Password123!' }),
      }),
      env,
    );

    const sessionCookie = cookieHeaderFromSetCookie(readSetCookie(signup));

    const account = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/account?userId=attacker-id', {
        method: 'GET',
        headers: { cookie: sessionCookie },
      }),
      env,
    );

    expect(account.status).toBe(200);
    const body = await account.json() as {
      data: {
        user: { email: string; id: string };
        subscription: { planCode: string };
        entitlements: Array<{ key: string; status: string }>;
      };
    };

    expect(body.data.user.email).toBe('owner2@businessflow.dev');
    expect(body.data.subscription?.planCode).toBe('free');
    expect(body.data.entitlements[0]?.key).toBe('core.recording');
    expect(body.data.user.id).not.toBe('attacker-id');
  });

  it('authenticated API access works via bearer token path (MV3-ready)', async () => {
    const provider = new MockAuthProvider();
    const repository = new InMemoryAuthRepository();
    const { app, env } = createAuthTestApp(provider, repository);

    const signup = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'bearer@businessflow.dev', password: 'Password123!' }),
      }),
      env,
    );

    const signupBody = await signup.json() as { data: { user: { providerUserId: string; email: string } } };
    const token = provider.issueBearerForTest(signupBody.data.user.providerUserId, signupBody.data.user.email);

    const account = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/account', {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      }),
      env,
    );

    expect(account.status).toBe(200);
  });

  it('supports MV3 extension session-token login/logout flow', async () => {
    const provider = new MockAuthProvider();
    const repository = new InMemoryAuthRepository();
    const { app, env } = createAuthTestApp(provider, repository);

    await app.fetch(
      new Request('https://api.businessflow.local/api/v1/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'extension@businessflow.dev', password: 'Password123!' }),
      }),
      env,
    );

    const extensionLogin = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/auth/extension/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'extension@businessflow.dev', password: 'Password123!' }),
      }),
      env,
    );

    expect(extensionLogin.status).toBe(200);
    const loginBody = await extensionLogin.json() as { data: { sessionToken: string } };
    expect(loginBody.data.sessionToken.length).toBeGreaterThan(16);

    const entitlement = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/entitlement', {
        method: 'GET',
        headers: {
          authorization: `Session ${loginBody.data.sessionToken}`,
        },
      }),
      env,
    );
    expect(entitlement.status).toBe(200);

    const extensionLogout = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/auth/extension/logout', {
        method: 'POST',
        headers: {
          authorization: `Session ${loginBody.data.sessionToken}`,
        },
      }),
      env,
    );
    expect(extensionLogout.status).toBe(200);

    const afterLogout = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/entitlement', {
        method: 'GET',
        headers: {
          authorization: `Session ${loginBody.data.sessionToken}`,
        },
      }),
      env,
    );
    expect(afterLogout.status).toBe(401);
  });

  it('token validation failure invalidates session', async () => {
    const provider = new MockAuthProvider();
    const repository = new InMemoryAuthRepository();
    const { app, env } = createAuthTestApp(provider, repository);

    const signup = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'revoke@businessflow.dev', password: 'Password123!' }),
      }),
      env,
    );

    const sessionCookie = cookieHeaderFromSetCookie(readSetCookie(signup));
    provider.setForceUserValidationFailure(true);

    const me = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/auth/me', {
        method: 'GET',
        headers: { cookie: sessionCookie },
      }),
      env,
    );

    expect(me.status).toBe(401);
    const body = await me.json() as { error: { code: string } };
    expect(body.error.code).toMatch(/AUTH_/);
  });
});
