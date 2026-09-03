import { ApiError } from '../../errors/api-error.js';
import type { AuthenticatedIdentity } from '../../types.js';
import type { PaddleClient } from '../../billing/paddle-client.js';
import type { BillingRepository, BillingSubscriptionRecord } from '../../db/billing-repository.js';
import { mapPaddleEventToCustomer, mapPaddleEventToSubscription } from './webhook-mapper.js';
import { toSupportedBillingWebhookEvent } from './webhook-events.js';
import type { BillingCatalogResult, BillingCheckoutResult, BillingPortalResult, WebhookProcessResult } from './types.js';
import type { VerifiedPaddleWebhook } from '../../billing/webhook-signature.js';

interface BillingServiceOptions {
  priceMap: Record<string, string>;
  productMap: Record<string, string>;
  paddleClientToken: string;
  paddleEnvironment: 'sandbox';
  checkoutSuccessUrl: string;
  checkoutCancelUrl: string;
}

function isPaidStatus(status: string): boolean {
  return status === 'active' || status === 'trialing';
}

function toAccessState(status: string): WebhookProcessResult['state'] {
  if (status === 'active') return 'active';
  if (status === 'trialing') return 'trialing';
  if (status === 'paused') return 'paused';
  if (status === 'canceled') return 'canceled';
  if (status === 'past_due') return 'past_due';
  return 'inactive';
}

function findBestPlanCode(priceMap: Record<string, string>, priceId: string | null): string {
  if (!priceId) return 'unknown';
  const match = Object.entries(priceMap).find(([, configuredPriceId]) => configuredPriceId === priceId);
  return match?.[0] ?? priceId;
}

function resolveSubscriptionIds(subscriptions: BillingSubscriptionRecord[]): string[] {
  return subscriptions
    .map((subscription) => subscription.paddleSubscriptionId)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

/**
 * BusinessFlow explicit policy:
 * - active/trialing => paid access granted
 * - canceled/paused/past_due => paid access denied
 * - scheduled_change never revokes access by itself
 */
export class BillingService {
  constructor(
    private readonly repository: BillingRepository,
    private readonly paddle: PaddleClient,
    private readonly options: BillingServiceOptions,
  ) {}

  getCatalog(detectedCountryCode: string | null): BillingCatalogResult {
    return {
      environment: this.options.paddleEnvironment,
      clientToken: this.options.paddleClientToken,
      detectedCountryCode,
      plans: [
        {
          tier: 'starter',
          productId: this.options.productMap['starter'] ?? null,
          prices: {
            monthly: {
              planKey: 'starter-monthly',
              priceId: this.options.priceMap['starter-monthly'] ?? '',
              trialDays: 7,
            },
            yearly: {
              planKey: 'starter-yearly',
              priceId: this.options.priceMap['starter-yearly'] ?? '',
              trialDays: 7,
            },
          },
        },
        {
          tier: 'pro',
          productId: this.options.productMap['pro'] ?? null,
          prices: {
            monthly: {
              planKey: 'pro-monthly',
              priceId: this.options.priceMap['pro-monthly'] ?? '',
              trialDays: 7,
            },
            yearly: {
              planKey: 'pro-yearly',
              priceId: this.options.priceMap['pro-yearly'] ?? '',
              trialDays: 7,
            },
          },
        },
        {
          tier: 'advanced',
          productId: this.options.productMap['advanced'] ?? null,
          prices: {
            monthly: {
              planKey: 'advanced-monthly',
              priceId: this.options.priceMap['advanced-monthly'] ?? '',
              trialDays: 7,
            },
            yearly: {
              planKey: 'advanced-yearly',
              priceId: this.options.priceMap['advanced-yearly'] ?? '',
              trialDays: 7,
            },
          },
        },
      ],
    };
  }

  async startCheckout(identity: AuthenticatedIdentity, planKey: string): Promise<BillingCheckoutResult> {
    const priceId = this.options.priceMap[planKey];
    if (!priceId) {
      throw new ApiError({
        code: 'BILLING_PLAN_NOT_FOUND',
        status: 404,
        message: 'Requested billing plan is not configured',
      });
    }

    const user = await this.repository.findUserById(identity.userId);
    if (!user) {
      throw new ApiError({
        code: 'AUTH_USER_NOT_FOUND',
        status: 401,
        message: 'Authenticated user is no longer available',
      });
    }

    const checkout = await this.paddle.createCheckout({
      priceId,
      userId: identity.userId,
      email: identity.email,
      successUrl: this.options.checkoutSuccessUrl,
      cancelUrl: this.options.checkoutCancelUrl,
    });

    return {
      checkoutId: checkout.checkoutId,
      checkoutUrl: checkout.checkoutUrl,
      planKey,
      priceId,
    };
  }

  async createCustomerPortal(identity: AuthenticatedIdentity): Promise<BillingPortalResult> {
    const user = await this.repository.findUserById(identity.userId);
    if (!user?.paddleCustomerId) {
      throw new ApiError({
        code: 'BILLING_CUSTOMER_NOT_PROVISIONED',
        status: 409,
        message: 'Paddle customer is not provisioned for this BusinessFlow user',
      });
    }

    const subscriptions = await this.repository.listSubscriptionsByUserId(identity.userId);
    const subscriptionIds = resolveSubscriptionIds(subscriptions);
    const portal = await this.paddle.createCustomerPortalSession(user.paddleCustomerId, subscriptionIds);

    return {
      sessionId: portal.sessionId,
      portalUrl: portal.portalUrl,
    };
  }

  async processWebhookEvent(event: VerifiedPaddleWebhook, signatureTs: number): Promise<WebhookProcessResult> {
    const claimed = await this.repository.insertWebhookEventIfNew({
      eventId: event.eventId,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      payloadJson: JSON.stringify({ event_id: event.eventId, event_type: event.eventType, occurred_at: event.occurredAt, data: event.data }),
      signatureTs,
    });

    if (!claimed.shouldProcess) {
      return {
        duplicate: claimed.duplicate,
        applied: false,
        state: 'inactive',
        ignored: false,
      };
    }

    try {
      const supported = toSupportedBillingWebhookEvent(event);
      if (!supported) {
        await this.repository.markWebhookProcessed(event.eventId);
        return {
          duplicate: false,
          applied: false,
          state: 'inactive',
          ignored: true,
        };
      }

      if (supported.eventType === 'customer.created' || supported.eventType === 'customer.updated') {
        const normalized = mapPaddleEventToCustomer(supported.data);
        const hintedUser = normalized.userIdHint ? await this.repository.findUserById(normalized.userIdHint) : null;
        const emailUser = !hintedUser && normalized.email ? await this.repository.findUserByEmail(normalized.email) : null;
        const user = hintedUser ?? emailUser;

        if (!user) {
          throw new ApiError({
            code: 'BILLING_USER_ASSOCIATION_FAILED',
            status: 400,
            message: 'Could not associate paddle customer event to a BusinessFlow user',
          });
        }

        await this.repository.setUserPaddleCustomerId(user.id, normalized.customerId);
        await this.repository.markWebhookProcessed(event.eventId);
        return {
          duplicate: false,
          applied: true,
          state: 'inactive',
          ignored: false,
        };
      }

      if (supported.eventType === 'transaction.completed' || supported.eventType === 'transaction.payment_failed') {
        const normalized = mapPaddleEventToSubscription(supported.eventType, supported.data, supported.occurredAt);
        const bySubscription = await this.repository.getSubscriptionByPaddleId(normalized.subscriptionId);
        const byCustomer = await this.repository.findUserByPaddleCustomerId(normalized.customerId);
        const hintedUser = normalized.userIdHint ? await this.repository.findUserById(normalized.userIdHint) : null;
        const subscriptionUser = bySubscription ? await this.repository.findUserById(bySubscription.userId) : null;
        const resolved = hintedUser ?? subscriptionUser ?? byCustomer;

        if (!resolved) {
          throw new ApiError({
            code: 'BILLING_USER_ASSOCIATION_FAILED',
            status: 400,
            message: 'Could not associate paddle transaction event to a BusinessFlow user',
          });
        }

        await this.repository.setUserPaddleCustomerId(resolved.id, normalized.customerId);

        const applied = await this.repository.upsertSubscriptionFromWebhook({
          userId: resolved.id,
          planCode: findBestPlanCode(this.options.priceMap, normalized.priceId),
          status: normalized.status,
          occurredAt: event.occurredAt,
          paddleSubscriptionId: normalized.subscriptionId,
          paddleCustomerId: normalized.customerId,
          paddlePriceId: normalized.priceId,
          paddleProductId: normalized.productId,
          currentPeriodStartsAt: normalized.currentPeriodStartsAt,
          currentPeriodEndsAt: normalized.currentPeriodEndsAt,
          firstBilledAt: normalized.firstBilledAt,
          nextBilledAt: normalized.nextBilledAt,
          canceledAt: normalized.canceledAt,
          pausedAt: normalized.pausedAt,
          pastDueAt: normalized.pastDueAt,
          scheduledChangeAction: normalized.scheduledChangeAction,
          scheduledChangeEffectiveAt: normalized.scheduledChangeEffectiveAt,
          scheduledChangeResumeAt: normalized.scheduledChangeResumeAt,
        });

        await this.repository.setPaidEntitlement(resolved.id, applied.subscriptionId, isPaidStatus(normalized.status));
        await this.repository.markWebhookProcessed(event.eventId);

        return {
          duplicate: false,
          applied: applied.applied,
          state: toAccessState(normalized.status),
          ignored: false,
        };
      }

      const normalized = mapPaddleEventToSubscription(supported.eventType, supported.data, supported.occurredAt);
      let userId = normalized.userIdHint;
      if (!userId) {
        const bySubscription = await this.repository.getSubscriptionByPaddleId(normalized.subscriptionId);
        if (bySubscription) userId = bySubscription.userId;
      }
      if (!userId) {
        const byCustomer = await this.repository.findUserByPaddleCustomerId(normalized.customerId);
        if (byCustomer) userId = byCustomer.id;
      }
      if (!userId) {
        throw new ApiError({
          code: 'BILLING_USER_ASSOCIATION_FAILED',
          status: 400,
          message: 'Could not associate paddle subscription event to a BusinessFlow user',
        });
      }

      await this.repository.setUserPaddleCustomerId(userId, normalized.customerId);

      const applied = await this.repository.upsertSubscriptionFromWebhook({
        userId,
        planCode: findBestPlanCode(this.options.priceMap, normalized.priceId),
        status: normalized.status,
        occurredAt: event.occurredAt,
        paddleSubscriptionId: normalized.subscriptionId,
        paddleCustomerId: normalized.customerId,
        paddlePriceId: normalized.priceId,
        paddleProductId: normalized.productId,
        currentPeriodStartsAt: normalized.currentPeriodStartsAt,
        currentPeriodEndsAt: normalized.currentPeriodEndsAt,
        firstBilledAt: normalized.firstBilledAt,
        nextBilledAt: normalized.nextBilledAt,
        canceledAt: normalized.canceledAt,
        pausedAt: normalized.pausedAt,
        pastDueAt: normalized.pastDueAt,
        scheduledChangeAction: normalized.scheduledChangeAction,
        scheduledChangeEffectiveAt: normalized.scheduledChangeEffectiveAt,
        scheduledChangeResumeAt: normalized.scheduledChangeResumeAt,
      });

      await this.repository.setPaidEntitlement(userId, applied.subscriptionId, isPaidStatus(normalized.status));
      await this.repository.markWebhookProcessed(event.eventId);

      return {
        duplicate: false,
        applied: applied.applied,
        state: toAccessState(normalized.status),
        ignored: false,
      };
    } catch (error) {
      await this.repository.markWebhookFailed(event.eventId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}
