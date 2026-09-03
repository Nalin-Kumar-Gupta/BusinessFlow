export type BillingTier = 'starter' | 'pro' | 'advanced';
export type BillingInterval = 'monthly' | 'yearly';

export interface BillingCatalogPrice {
  planKey: string;
  priceId: string;
  trialDays: number;
}

export interface BillingCatalogPlan {
  tier: BillingTier;
  productId: string | null;
  prices: Record<BillingInterval, BillingCatalogPrice>;
}

export interface BillingCatalogResult {
  environment: 'sandbox';
  clientToken: string;
  plans: BillingCatalogPlan[];
  detectedCountryCode: string | null;
}

export interface BillingCheckoutResult {
  checkoutId: string;
  checkoutUrl: string;
  planKey: string;
  priceId: string;
}

export interface BillingPortalResult {
  sessionId: string;
  portalUrl: string;
}

export interface WebhookProcessResult {
  duplicate: boolean;
  applied: boolean;
  state: 'active' | 'trialing' | 'paused' | 'canceled' | 'past_due' | 'inactive';
  ignored: boolean;
}
