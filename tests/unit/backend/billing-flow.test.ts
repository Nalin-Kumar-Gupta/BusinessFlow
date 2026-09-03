import { describe, expect, it, beforeEach } from 'vitest';
import type { EnvBindings } from '../../../backend/src/types.js';
import { resetRateLimitStoreForTests } from '../../../backend/src/http/rate-limit.js';
import { createBillingTestApp } from './auth-test-doubles.js';
import { readSetCookie } from './helpers.js';

function cookieHeaderFromSetCookie(setCookie: string): string {
  return setCookie.split(';')[0] ?? '';
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload) as BufferSource);
  const bytes = new Uint8Array(signature);
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function makePaddleSignatureHeader(secret: string, rawBody: string, ts: number): Promise<string> {
  const digest = await hmacHex(secret, `${ts}:${rawBody}`);
  return `ts=${ts};h1=${digest}`;
}

async function signedWebhookRequest(body: string, signatureSecret = 'whsec_test_secret'): Promise<Request> {
  const ts = Math.floor(Date.now() / 1000);
  const signature = await makePaddleSignatureHeader(signatureSecret, body, ts);
  return new Request('https://api.businessflow.local/api/v1/billing/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Paddle-Signature': signature,
    },
    body,
  });
}

async function signupAndGetSession(app: { fetch: (request: Request, env: EnvBindings) => Promise<Response> }, env: EnvBindings, email = 'bill@businessflow.dev') {
  const signup = await app.fetch(
    new Request('https://api.businessflow.local/api/v1/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'Password123!' }),
    }),
    env,
  );

  const body = await signup.json() as { data: { user: { userId: string; email: string; providerUserId: string } } };
  return {
    sessionCookie: cookieHeaderFromSetCookie(readSetCookie(signup)),
    user: body.data.user,
  };
}

describe('paddle billing flow (sandbox)', () => {
  beforeEach(() => {
    resetRateLimitStoreForTests();
  });

  it('returns sandbox billing catalog with required plans', async () => {
    const { app, env } = createBillingTestApp();

    const response = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/billing/catalog', {
        method: 'GET',
      }),
      env,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { environment: string; clientToken: string; plans: Array<{ tier: string }> } };
    expect(body.data.environment).toBe('sandbox');
    expect(body.data.clientToken.startsWith('test_')).toBe(true);
    expect(body.data.plans.map((plan) => plan.tier)).toEqual(['starter', 'pro', 'advanced']);
  });

  it('blocks unauthorized checkout attempts', async () => {
    const { app, env } = createBillingTestApp();

    const response = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/billing/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planKey: 'pro-monthly' }),
      }),
      env,
    );

    expect(response.status).toBe(401);
  });

  it('creates checkout for authenticated user', async () => {
    const { app, env, paddle } = createBillingTestApp();
    const { sessionCookie } = await signupAndGetSession(app, env, 'checkout@businessflow.dev');

    const response = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/billing/checkout', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: sessionCookie,
        },
        body: JSON.stringify({ planKey: 'pro-monthly' }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { checkoutUrl: string; planKey: string; priceId: string } };
    expect(body.data.planKey).toBe('pro-monthly');
    expect(body.data.priceId).toBe('pri_pro_monthly');
    expect(body.data.checkoutUrl).toContain('sandbox-checkout.paddle.com');
    expect(paddle.createdCheckouts).toHaveLength(1);
  });

  it('rejects invalid webhook signatures and does not process payload', async () => {
    const { app, env, billingRepository } = createBillingTestApp();
    const response = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/billing/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Paddle-Signature': 'ts=1;h1=deadbeef',
        },
        body: JSON.stringify({ event_id: 'evt_invalid_sig', event_type: 'subscription.created', occurred_at: new Date().toISOString(), data: {} }),
      }),
      env,
    );

    expect(response.status).toBe(401);
    expect(billingRepository.webhookEvents.has('evt_invalid_sig')).toBe(false);
  });

  it('rejects malformed webhook body even if signature matches raw body', async () => {
    const { app, env } = createBillingTestApp();
    const request = await signedWebhookRequest('not-json');
    const response = await app.fetch(request, env);
    expect(response.status).toBe(401);
  });

  it('safely ignores unsupported event types', async () => {
    const { app, env } = createBillingTestApp();
    const raw = JSON.stringify({
      event_id: 'evt_unsupported',
      event_type: 'report.updated',
      occurred_at: new Date().toISOString(),
      data: { id: 'rpt_1' },
    });

    const response = await app.fetch(await signedWebhookRequest(raw), env);
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { ignored: boolean; applied: boolean } };
    expect(body.data.ignored).toBe(true);
    expect(body.data.applied).toBe(false);
  });

  it('provisions user from customer.created event', async () => {
    const { app, env, billingRepository } = createBillingTestApp();
    const { user } = await signupAndGetSession(app, env, 'customer-created@businessflow.dev');

    const raw = JSON.stringify({
      event_id: 'evt_customer_created',
      event_type: 'customer.created',
      occurred_at: new Date().toISOString(),
      data: {
        id: 'ctm_customer_created',
        email: 'customer-created@businessflow.dev',
      },
    });

    const response = await app.fetch(await signedWebhookRequest(raw), env);
    expect(response.status).toBe(200);

    const resolved = await billingRepository.findUserById(user.userId);
    expect(resolved?.paddleCustomerId).toBe('ctm_customer_created');
  });

  it('processes valid subscription events, enforces idempotency, and handles out-of-order events', async () => {
    const { app, env, billingRepository } = createBillingTestApp();
    const { user } = await signupAndGetSession(app, env, 'lifecycle@businessflow.dev');

    const makeAndSend = async (eventId: string, eventType: string, occurredAt: string, status: string) => {
      const payload = {
        event_id: eventId,
        event_type: eventType,
        occurred_at: occurredAt,
        data: {
          id: 'sub_lifecycle',
          customer_id: 'cus_lifecycle',
          status,
          transaction_id: 'txn_lifecycle',
          address_id: 'add_lifecycle',
          currency_code: 'USD',
          created_at: occurredAt,
          updated_at: occurredAt,
          collection_mode: 'automatic',
          billing_cycle: { interval: 'month', frequency: 1 },
          custom_data: { businessflow_user_id: user.userId },
          items: [{
            price_id: 'pri_pro_monthly',
            quantity: 1,
            status: 'active',
            price: { id: 'pri_pro_monthly', product_id: 'pro_123' },
          }],
          current_billing_period: {
            starts_at: occurredAt,
            ends_at: new Date(Date.parse(occurredAt) + 30 * 24 * 3600 * 1000).toISOString(),
          },
          scheduled_change: {
            action: 'cancel',
            effective_at: new Date(Date.parse(occurredAt) + 14 * 24 * 3600 * 1000).toISOString(),
          },
        },
      };

      return app.fetch(await signedWebhookRequest(JSON.stringify(payload)), env);
    };

    const t1 = '2026-01-01T00:00:00.000Z';
    const t2 = '2026-01-02T00:00:00.000Z';
    const t3 = '2026-01-03T00:00:00.000Z';

    const created = await makeAndSend('evt_created', 'subscription.created', t1, 'active');
    expect(created.status).toBe(200);

    const duplicate = await makeAndSend('evt_created', 'subscription.created', t1, 'active');
    expect(duplicate.status).toBe(200);
    const duplicateBody = await duplicate.json() as { data: { duplicate: boolean } };
    expect(duplicateBody.data.duplicate).toBe(true);

    const updated = await makeAndSend('evt_updated', 'subscription.updated', t2, 'active');
    expect(updated.status).toBe(200);

    const outOfOrder = await makeAndSend('evt_old', 'subscription.canceled', t1, 'canceled');
    expect(outOfOrder.status).toBe(200);
    const outOfOrderBody = await outOfOrder.json() as { data: { applied: boolean } };
    expect(outOfOrderBody.data.applied).toBe(false);

    const canceled = await makeAndSend('evt_canceled', 'subscription.canceled', t3, 'canceled');
    expect(canceled.status).toBe(200);

    const sub = await billingRepository.getSubscriptionByPaddleId('sub_lifecycle');
    expect(sub?.status).toBe('canceled');
    expect(sub?.scheduledChangeAction).toBe('cancel');
    expect(sub?.lastEventTime).toBe(t3);
  });

  it('creates customer portal session only for authenticated linked BusinessFlow user', async () => {
    const { app, env, paddle, billingRepository } = createBillingTestApp();
    const { user, sessionCookie } = await signupAndGetSession(app, env, 'portal@businessflow.dev');

    const noCustomer = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/billing/portal', {
        method: 'POST',
        headers: { cookie: sessionCookie },
      }),
      env,
    );
    expect(noCustomer.status).toBe(409);

    await billingRepository.setUserPaddleCustomerId(user.userId, 'ctm_portal_1');
    await billingRepository.upsertSubscriptionFromWebhook({
      userId: user.userId,
      planCode: 'pro-monthly',
      status: 'active',
      occurredAt: new Date().toISOString(),
      paddleSubscriptionId: 'sub_portal_1',
      paddleCustomerId: 'ctm_portal_1',
      paddlePriceId: 'pri_pro_monthly',
      paddleProductId: 'pro_123',
      currentPeriodStartsAt: null,
      currentPeriodEndsAt: null,
      firstBilledAt: null,
      nextBilledAt: null,
      canceledAt: null,
      pausedAt: null,
      pastDueAt: null,
      scheduledChangeAction: null,
      scheduledChangeEffectiveAt: null,
      scheduledChangeResumeAt: null,
    });

    const response = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/billing/portal', {
        method: 'POST',
        headers: { cookie: sessionCookie },
      }),
      env,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { portalUrl: string } };
    expect(body.data.portalUrl).toContain('sandbox-customer-portal.paddle.com');
    expect(paddle.createdPortalSessions).toHaveLength(1);
    expect(paddle.createdPortalSessions[0]?.customerId).toBe('ctm_portal_1');
  });

  it('rate limits webhook flooding from same source', async () => {
    const { app, env } = createBillingTestApp();
    const raw = JSON.stringify({
      event_id: 'evt_rate_limited',
      event_type: 'subscription.created',
      occurred_at: new Date().toISOString(),
      data: {
        id: 'sub_rate',
        customer_id: 'cus_rate',
        status: 'active',
        custom_data: { businessflow_user_id: 'user_unknown' },
      },
    });

    const ts = Math.floor(Date.now() / 1000);
    const signature = await makePaddleSignatureHeader('whsec_test_secret', raw, ts);

    let final: Response | null = null;
    for (let attempt = 0; attempt < 121; attempt += 1) {
      final = await app.fetch(
        new Request('https://api.businessflow.local/api/v1/billing/webhook', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'Paddle-Signature': signature,
            'cf-connecting-ip': '10.9.0.5',
          },
          body: raw,
        }),
        env,
      );
    }

    if (!final) throw new Error('expected final response');
    expect(final.status).toBe(429);
    const body = await final.json() as { error: { code: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
  });
});
