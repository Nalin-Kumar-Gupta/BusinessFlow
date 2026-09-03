import { Environment, Paddle } from '@paddle/paddle-node-sdk';
import type { EventEntity } from '@paddle/paddle-node-sdk';
import { ApiError } from '../errors/api-error.js';

export interface VerifiedPaddleWebhook {
  eventId: string;
  eventType: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

const paddleWebhookVerifier = new Paddle('sandbox_webhook_verifier_only', {
  environment: Environment.sandbox,
});

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toVerifiedEvent(event: EventEntity): VerifiedPaddleWebhook {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    data: asRecord(event.data),
  };
}

export async function verifyPaddleWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string,
): Promise<VerifiedPaddleWebhook> {
  if (!signatureHeader || signatureHeader.trim().length === 0) {
    throw new ApiError({
      code: 'BILLING_WEBHOOK_MISSING_SIGNATURE',
      status: 401,
      message: 'Paddle-Signature header is required',
    });
  }

  try {
    const event = await paddleWebhookVerifier.webhooks.unmarshal(rawBody, webhookSecret, signatureHeader);
    return toVerifiedEvent(event);
  } catch (error) {
    throw new ApiError({
      code: 'BILLING_WEBHOOK_SIGNATURE_INVALID',
      status: 401,
      message: 'Webhook signature verification failed',
      details: {
        reason: error instanceof Error ? error.message : String(error),
      },
    });
  }
}
