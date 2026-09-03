import { describe, expect, it } from 'vitest';
import { createApp } from '../../../backend/src/app.js';
import { ApiError } from '../../../backend/src/errors/api-error.js';
import type { EntitlementRepository } from '../../../backend/src/db/entitlement-repository.js';
import { createBillingTestApp } from './auth-test-doubles.js';
import { makeEnv, readSetCookie } from './helpers.js';

function cookieHeaderFromSetCookie(setCookie: string): string {
  return setCookie.split(';')[0] ?? '';
}

async function signupAndGetSession() {
  const context = createBillingTestApp();
  const signup = await context.app.fetch(
    new Request('https://api.businessflow.local/api/v1/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `ent-${crypto.randomUUID()}@businessflow.dev`, password: 'Password123!' }),
    }),
    context.env,
  );

  const body = await signup.json() as { data: { user: { userId: string } } };
  return {
    ...context,
    userId: body.data.user.userId,
    sessionCookie: cookieHeaderFromSetCookie(readSetCookie(signup)),
  };
}

function seedSubscription(
  context: Awaited<ReturnType<typeof signupAndGetSession>>,
  options: { status: string; planCode: string; periodEndsAt: string | null; entitlementEnabled?: boolean },
): void {
  context.billingRepository.subscriptionsByPaddleId.set(`sub_${crypto.randomUUID()}`, {
    id: `sub_${crypto.randomUUID()}`,
    userId: context.userId,
    status: options.status,
    planCode: options.planCode,
    provider: 'paddle',
    paddleSubscriptionId: `sub_${crypto.randomUUID()}`,
    paddleCustomerId: `cus_${crypto.randomUUID()}`,
    paddlePriceId: 'pri_123',
    paddleProductId: 'pro_123',
    currentPeriodStartsAt: new Date().toISOString(),
    currentPeriodEndsAt: options.periodEndsAt,
    firstBilledAt: null,
    nextBilledAt: null,
    canceledAt: options.status === 'canceled' ? new Date().toISOString() : null,
    pausedAt: options.status === 'paused' ? new Date().toISOString() : null,
    pastDueAt: options.status === 'past_due' ? new Date().toISOString() : null,
    scheduledChangeAction: null,
    scheduledChangeEffectiveAt: null,
    scheduledChangeResumeAt: null,
    lastEventTime: new Date().toISOString(),
  });

  context.billingRepository.paidEntitlementByUser.set(context.userId, {
    subscriptionId: `sub_${crypto.randomUUID()}`,
    enabled: options.entitlementEnabled ?? (options.status === 'active' || options.status === 'trialing'),
  });
}

async function getEntitlement(context: Awaited<ReturnType<typeof signupAndGetSession>>, extraHeaders: Record<string, string> = {}) {
  const response = await context.app.fetch(
    new Request('https://api.businessflow.local/api/v1/entitlement?clientState=premium', {
      method: 'GET',
      headers: {
        cookie: context.sessionCookie,
        'x-businessflow-entitlement': 'active',
        ...extraHeaders,
      },
    }),
    context.env,
  );

  return response;
}

describe('entitlement and authorization flow', () => {
  it('returns free user entitlement by default', async () => {
    const context = await signupAndGetSession();
    const response = await getEntitlement(context);
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { plan: string; access: { granted: boolean; state: string } } };
    expect(body.data.plan).toBe('free');
    expect(body.data.access.granted).toBe(false);
    expect(body.data.access.state).toBe('free');
  });

  it('returns active paid user entitlement', async () => {
    const context = await signupAndGetSession();
    seedSubscription(context, {
      status: 'active',
      planCode: 'pro-monthly',
      periodEndsAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      entitlementEnabled: true,
    });

    const response = await getEntitlement(context);
    const body = await response.json() as { data: { access: { granted: boolean; state: string } } };
    expect(response.status).toBe(200);
    expect(body.data.access.granted).toBe(true);
    expect(body.data.access.state).toBe('paid_active');
  });

  it('returns canceled_grace without paid access once subscription is canceled', async () => {
    const context = await signupAndGetSession();
    seedSubscription(context, {
      status: 'canceled',
      planCode: 'pro-monthly',
      periodEndsAt: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
      entitlementEnabled: false,
    });

    const response = await getEntitlement(context);
    const body = await response.json() as { data: { access: { granted: boolean; state: string } } };
    expect(body.data.access.granted).toBe(false);
    expect(body.data.access.state).toBe('canceled_grace');
  });

  it('returns expired when paid subscription period has ended', async () => {
    const context = await signupAndGetSession();
    seedSubscription(context, {
      status: 'active',
      planCode: 'pro-monthly',
      periodEndsAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      entitlementEnabled: false,
    });

    const response = await getEntitlement(context);
    const body = await response.json() as { data: { access: { granted: boolean; state: string } } };
    expect(body.data.access.granted).toBe(false);
    expect(body.data.access.state).toBe('expired');
  });

  it('returns past_due when payment has failed', async () => {
    const context = await signupAndGetSession();
    seedSubscription(context, {
      status: 'past_due',
      planCode: 'pro-monthly',
      periodEndsAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      entitlementEnabled: false,
    });

    const response = await getEntitlement(context);
    const body = await response.json() as { data: { access: { granted: boolean; state: string } } };
    expect(body.data.access.granted).toBe(false);
    expect(body.data.access.state).toBe('past_due');
  });

  it('returns revoked when access is revoked at user level', async () => {
    const context = await signupAndGetSession();
    seedSubscription(context, {
      status: 'active',
      planCode: 'pro-monthly',
      periodEndsAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      entitlementEnabled: true,
    });

    context.entitlementRepository.revokedUsers.set(context.userId, {
      revokedAt: new Date().toISOString(),
      reason: 'manual review',
    });

    const response = await getEntitlement(context);
    const body = await response.json() as { data: { access: { granted: boolean; state: string } } };
    expect(body.data.access.granted).toBe(false);
    expect(body.data.access.state).toBe('revoked');
  });

  it('requires authentication and rejects expired authorization', async () => {
    const context = await signupAndGetSession();

    const anonymous = await context.app.fetch(new Request('https://api.businessflow.local/api/v1/entitlement'), context.env);
    expect(anonymous.status).toBe(401);

    const sessionEntry = [...context.authRepository.sessionsByHash.values()][0];
    expect(sessionEntry).toBeDefined();
    if (!sessionEntry) throw new Error('session not found in test setup');
    sessionEntry.expiresAt = new Date(Date.now() - 1000).toISOString();

    const expired = await getEntitlement(context);
    expect(expired.status).toBe(401);
  });

  it('ignores forged client entitlement claims', async () => {
    const context = await signupAndGetSession();

    const response = await getEntitlement(context, {
      'x-businessflow-entitlement': 'premium-active',
      'x-subscription-status': 'active',
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { plan: string; access: { granted: boolean; state: string } } };
    expect(body.data.plan).toBe('free');
    expect(body.data.access.granted).toBe(false);
    expect(body.data.access.state).toBe('free');
  });

  it('handles backend entitlement dependency failure safely', async () => {
    const failingRepo: EntitlementRepository = {
      async getSnapshotForUser(): Promise<never> {
        throw new ApiError({
          code: 'ENTITLEMENT_STORE_DOWN',
          status: 503,
          message: 'entitlement store unavailable',
        });
      },
    };

    const context = createBillingTestApp();
    const app = createApp({
      createAuthProvider: () => context.provider,
      createAuthRepository: () => context.authRepository,
      createPaddleClient: () => context.paddle,
      createBillingRepository: () => context.billingRepository,
      createEntitlementRepository: () => failingRepo,
    });

    const signup = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: `err-${crypto.randomUUID()}@businessflow.dev`, password: 'Password123!' }),
      }),
      context.env,
    );
    const sessionCookie = cookieHeaderFromSetCookie(readSetCookie(signup));

    const response = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/entitlement', {
        headers: { cookie: sessionCookie },
      }),
      context.env,
    );

    expect(response.status).toBe(503);
  });

  it('supports repeated entitlement reads without mutating state', async () => {
    const context = await signupAndGetSession();
    seedSubscription(context, {
      status: 'trialing',
      planCode: 'pro-monthly',
      periodEndsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      entitlementEnabled: true,
    });

    const first = await getEntitlement(context);
    const second = await getEntitlement(context);

    const firstBody = await first.json() as { data: { access: { state: string; granted: boolean } } };
    const secondBody = await second.json() as { data: { access: { state: string; granted: boolean } } };

    expect(firstBody.data.access.state).toBe('trial');
    expect(firstBody.data.access.granted).toBe(true);
    expect(secondBody.data.access.state).toBe('trial');
    expect(secondBody.data.access.granted).toBe(true);
  });
});
