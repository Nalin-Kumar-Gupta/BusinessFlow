import { ApiError } from '../../errors/api-error.js';

export interface NormalizedPaddleSubscriptionEvent {
  userIdHint: string | null;
  customerId: string;
  subscriptionId: string;
  status: string;
  priceId: string | null;
  productId: string | null;
  currentPeriodStartsAt: string | null;
  currentPeriodEndsAt: string | null;
  firstBilledAt: string | null;
  nextBilledAt: string | null;
  canceledAt: string | null;
  pausedAt: string | null;
  pastDueAt: string | null;
  scheduledChangeAction: string | null;
  scheduledChangeEffectiveAt: string | null;
  scheduledChangeResumeAt: string | null;
}

export interface NormalizedPaddleCustomerEvent {
  customerId: string;
  userIdHint: string | null;
  email: string | null;
}

function asRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return input as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function pickString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(source[key]);
    if (value) return value;
  }
  return null;
}

function parseSubscriptionStatus(eventType: string, dataStatus: string | null): string {
  if (eventType.endsWith('.canceled')) return 'canceled';
  if (eventType.endsWith('.paused')) return 'paused';
  if (eventType.endsWith('.resumed')) return 'active';
  if (eventType.endsWith('.activated')) return 'active';
  if (eventType.endsWith('.trialing')) return 'trialing';
  if (eventType.includes('payment_failed') || eventType.endsWith('.past_due')) return 'past_due';
  return dataStatus ?? 'inactive';
}

export function mapPaddleEventToSubscription(
  eventType: string,
  data: Record<string, unknown>,
  occurredAt: string,
): NormalizedPaddleSubscriptionEvent {
  const customer = asRecord(data['customer']);
  const customData = asRecord(data['customData'] ?? data['custom_data']);
  const scheduledChange = asRecord(data['scheduledChange'] ?? data['scheduled_change']);

  const customerId = pickString(data, ['customerId', 'customer_id']) || pickString(customer, ['id']);
  const subscriptionId = pickString(data, ['id', 'subscriptionId', 'subscription_id']);

  if (!customerId || !subscriptionId) {
    throw new ApiError({
      code: 'BILLING_WEBHOOK_UNSUPPORTED_PAYLOAD',
      status: 400,
      message: 'Webhook payload is missing customer/subscription identity',
    });
  }

  const items = Array.isArray(data['items']) ? data['items'] : [];
  const item0 = asRecord(items[0]);
  const price = asRecord(item0['price']);
  const product = asRecord(item0['product']);
  const period = asRecord(data['currentBillingPeriod'] ?? data['current_billing_period']);

  return {
    userIdHint: pickString(customData, ['businessflow_user_id']),
    customerId,
    subscriptionId,
    status: parseSubscriptionStatus(eventType, pickString(data, ['status'])),
    priceId: pickString(item0, ['priceId', 'price_id']) || pickString(price, ['id']),
    productId: pickString(product, ['id']) || pickString(price, ['productId', 'product_id']),
    currentPeriodStartsAt: pickString(period, ['startsAt', 'starts_at']),
    currentPeriodEndsAt: pickString(period, ['endsAt', 'ends_at']),
    firstBilledAt: pickString(data, ['firstBilledAt', 'first_billed_at']),
    nextBilledAt: pickString(data, ['nextBilledAt', 'next_billed_at']),
    canceledAt: pickString(data, ['canceledAt', 'canceled_at']),
    pausedAt: pickString(data, ['pausedAt', 'paused_at']),
    pastDueAt: eventType.includes('payment_failed') || eventType.endsWith('.past_due')
      ? occurredAt
      : pickString(data, ['pastDueAt', 'past_due_at']),
    scheduledChangeAction: pickString(scheduledChange, ['action']),
    scheduledChangeEffectiveAt: pickString(scheduledChange, ['effectiveAt', 'effective_at']),
    scheduledChangeResumeAt: pickString(scheduledChange, ['resumeAt', 'resume_at']),
  };
}

export function mapPaddleEventToCustomer(data: Record<string, unknown>): NormalizedPaddleCustomerEvent {
  const customData = asRecord(data['customData'] ?? data['custom_data']);
  const customerId = pickString(data, ['id', 'customerId', 'customer_id']);
  if (!customerId) {
    throw new ApiError({
      code: 'BILLING_WEBHOOK_UNSUPPORTED_PAYLOAD',
      status: 400,
      message: 'Webhook payload is missing customer identity',
    });
  }

  return {
    customerId,
    userIdHint: pickString(customData, ['businessflow_user_id']),
    email: pickString(data, ['email']),
  };
}

export function shouldProcessBillingEvent(eventType: string): boolean {
  return eventType === 'subscription.created'
    || eventType === 'subscription.updated'
    || eventType === 'subscription.canceled'
    || eventType === 'subscription.activated'
    || eventType === 'subscription.paused'
    || eventType === 'subscription.resumed'
    || eventType === 'subscription.past_due'
    || eventType === 'subscription.trialing'
    || eventType === 'customer.created'
    || eventType === 'customer.updated'
    || eventType === 'transaction.completed'
    || eventType === 'transaction.payment_failed';
}
