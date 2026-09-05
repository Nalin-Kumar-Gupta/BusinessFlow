import { jsonSuccess } from '../../../http/response.js';
import { parseJsonBody } from '../../../validation/json.js';
import { validateCheckoutRequest } from '../../../validation/billing.js';
import type { AuthContext } from '../../../types.js';
import type { AuthService } from '../../../domain/auth/service.js';
import type { BillingService } from '../../../domain/billing/service.js';
import { verifyPaddleWebhookSignature } from '../../../billing/webhook-signature.js';
import { enforceRateLimit } from '../../../http/rate-limit.js';

export async function getBillingCatalog(
  request: Request,
  billingService: BillingService,
  requestId: string,
): Promise<Response> {
  const cf = (request as Request & { cf?: { country?: string } }).cf;
  const countryCode = typeof cf?.country === 'string' && cf.country.trim().length > 0
    ? cf.country.trim().toUpperCase()
    : null;
  const catalog = await billingService.getCatalog(countryCode);
  return jsonSuccess(catalog, requestId, 200);
}

export async function createCheckout(
  request: Request,
  auth: AuthContext,
  authService: AuthService,
  billingService: BillingService,
  requestId: string,
): Promise<Response> {
  const identity = await authService.requireIdentity(auth);
  const body = await parseJsonBody(request);
  const input = validateCheckoutRequest(body);
  const checkout = await billingService.startCheckout(identity, input.planKey);
  return jsonSuccess(checkout, requestId, 200);
}

export async function createCustomerPortal(
  auth: AuthContext,
  authService: AuthService,
  billingService: BillingService,
  requestId: string,
): Promise<Response> {
  const identity = await authService.requireIdentity(auth);
  const portal = await billingService.createCustomerPortal(identity);
  return jsonSuccess(portal, requestId, 200);
}

export async function handlePaddleWebhook(
  request: Request,
  billingService: BillingService,
  requestId: string,
  webhookSecret: string,
): Promise<Response> {
  enforceRateLimit(request, {
    bucket: 'billing-webhook',
    limit: 120,
    windowMs: 60 * 1000,
  });

  const rawBody = await request.text();
  const verified = await verifyPaddleWebhookSignature(
    rawBody,
    request.headers.get('Paddle-Signature') ?? request.headers.get('paddle-signature'),
    webhookSecret,
  );

  const result = await billingService.processWebhookEvent(verified, Math.floor(Date.now() / 1000));
  return jsonSuccess(result, requestId, 200);
}
