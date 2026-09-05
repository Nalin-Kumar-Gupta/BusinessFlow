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
  readFormattedPrice: (priceId: string, countryCode: string | null) => Promise<string | null>;
}

interface PaddleTransactionResponse {
  data?: {
    id?: string;
    checkout?: {
      url?: string;
    };
  };
}

interface PaddlePriceResponse {
  data?: {
    unitPrice?: {
      amount?: string;
      currencyCode?: string;
    };
    unit_price?: {
      amount?: string;
      currency_code?: string;
    };
    currencyCode?: string;
    currency_code?: string;
    formattedPrice?: string;
    formatted_price?: string;
    formattedUnitPrice?: string;
    formatted_unit_price?: string;
  };
}

interface PaddleErrorResponse {
  error?: {
    detail?: string;
    type?: string;
  };
}

function toFormattedPrice(payload: PaddlePriceResponse): string | null {
  const data = payload.data;
  if (!data) return null;

  const direct = [
    data.formattedPrice,
    data.formatted_price,
    data.formattedUnitPrice,
    data.formatted_unit_price,
  ];
  for (const candidate of direct) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }

  const amount = data.unitPrice?.amount ?? data.unit_price?.amount;
  const currency = data.unitPrice?.currencyCode ?? data.unit_price?.currency_code ?? data.currencyCode ?? data.currency_code;
  if (!amount || !currency) return null;

  const numeric = Number.parseFloat(amount);
  if (!Number.isFinite(numeric)) return null;

  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(numeric / 100);
  } catch {
    return null;
  }
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

  async readFormattedPrice(priceId: string, countryCode: string | null): Promise<string | null> {
    const params = new URLSearchParams();
    if (countryCode && countryCode.trim().length > 0) {
      params.set('address[country_code]', countryCode.trim().toUpperCase());
    }
    const query = params.toString();
    const url = `${this.baseUrl}/prices/${encodeURIComponent(priceId)}${query ? `?${query}` : ''}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) return null;
    const payload = await response.json().catch(() => ({} as PaddlePriceResponse));
    return toFormattedPrice(payload);
  }
}
