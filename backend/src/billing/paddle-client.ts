import { Environment, Paddle } from '@paddle/paddle-node-sdk';
import { ApiError } from '../errors/api-error.js';

export interface CreateCheckoutInput {
  priceId: string;
  userId: string;
  email: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSession {
  checkoutId: string;
  checkoutUrl: string;
}

export interface CustomerPortalSession {
  sessionId: string;
  portalUrl: string;
}

export interface PaddleClient {
  createCheckout: (input: CreateCheckoutInput) => Promise<CheckoutSession>;
  createCustomerPortalSession: (customerId: string, subscriptionIds: string[]) => Promise<CustomerPortalSession>;
}

interface PaddleTransactionResponse {
  data?: {
    id?: string;
    checkout?: {
      url?: string;
    };
  };
}

interface PaddleErrorResponse {
  error?: {
    detail?: string;
    type?: string;
  };
}

export class PaddleApiClient implements PaddleClient {
  private readonly sdk: Paddle;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {
    this.sdk = new Paddle(apiKey, {
      environment: Environment.sandbox,
    });
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const response = await fetch(`${this.baseUrl}/transactions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        items: [{ price_id: input.priceId, quantity: 1 }],
        customer: { email: input.email },
        custom_data: {
          businessflow_user_id: input.userId,
        },
        checkout: {
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
        },
      }),
    });

    if (!response.ok) {
      const payload: PaddleErrorResponse = await response.json().catch(() => ({} as PaddleErrorResponse));
      throw new ApiError({
        code: 'BILLING_CHECKOUT_CREATE_FAILED',
        status: 502,
        message: payload.error?.detail || payload.error?.type || 'Paddle checkout creation failed',
      });
    }

    const payload = await response.json() as PaddleTransactionResponse;
    const checkoutId = payload.data?.id;
    const checkoutUrl = payload.data?.checkout?.url;
    if (!checkoutId || !checkoutUrl) {
      throw new ApiError({
        code: 'BILLING_PROVIDER_INVALID_RESPONSE',
        status: 502,
        message: 'Paddle checkout response was missing expected fields',
      });
    }

    return {
      checkoutId,
      checkoutUrl,
    };
  }

  async createCustomerPortalSession(customerId: string, subscriptionIds: string[]): Promise<CustomerPortalSession> {
    try {
      const session = await this.sdk.customerPortalSessions.create(customerId, subscriptionIds);
      return {
        sessionId: session.id,
        portalUrl: session.urls.general.overview,
      };
    } catch (error) {
      throw new ApiError({
        code: 'BILLING_PORTAL_SESSION_CREATE_FAILED',
        status: 502,
        message: error instanceof Error ? error.message : 'Failed to create customer portal session',
      });
    }
  }
}
