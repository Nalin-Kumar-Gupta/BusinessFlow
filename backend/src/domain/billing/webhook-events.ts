import type { VerifiedPaddleWebhook } from '../../billing/webhook-signature.js';

export type BillingWebhookEventType =
  | 'subscription.created'
  | 'subscription.updated'
  | 'subscription.canceled'
  | 'subscription.activated'
  | 'subscription.paused'
  | 'subscription.resumed'
  | 'subscription.past_due'
  | 'subscription.trialing'
  | 'customer.created'
  | 'customer.updated'
  | 'transaction.completed'
  | 'transaction.payment_failed';

interface BillingWebhookEventBase {
  eventId: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

export interface SubscriptionWebhookEvent extends BillingWebhookEventBase {
  eventType:
    | 'subscription.created'
    | 'subscription.updated'
    | 'subscription.canceled'
    | 'subscription.activated'
    | 'subscription.paused'
    | 'subscription.resumed'
    | 'subscription.past_due'
    | 'subscription.trialing';
}

export interface CustomerWebhookEvent extends BillingWebhookEventBase {
  eventType: 'customer.created' | 'customer.updated';
}

export interface TransactionWebhookEvent extends BillingWebhookEventBase {
  eventType: 'transaction.completed' | 'transaction.payment_failed';
}

export type SupportedBillingWebhookEvent = SubscriptionWebhookEvent | CustomerWebhookEvent | TransactionWebhookEvent;

function asSupportedType(value: string): BillingWebhookEventType | null {
  switch (value) {
    case 'subscription.created':
    case 'subscription.updated':
    case 'subscription.canceled':
    case 'subscription.activated':
    case 'subscription.paused':
    case 'subscription.resumed':
    case 'subscription.past_due':
    case 'subscription.trialing':
    case 'customer.created':
    case 'customer.updated':
    case 'transaction.completed':
    case 'transaction.payment_failed':
      return value;
    default:
      return null;
  }
}

export function toSupportedBillingWebhookEvent(event: VerifiedPaddleWebhook): SupportedBillingWebhookEvent | null {
  const eventType = asSupportedType(event.eventType);
  if (!eventType) return null;

  return {
    eventId: event.eventId,
    eventType,
    occurredAt: event.occurredAt,
    data: event.data,
  } as SupportedBillingWebhookEvent;
}
