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

export interface BillingCatalogPayload {
  environment: 'sandbox';
  clientToken: string;
  detectedCountryCode: string | null;
  plans: BillingCatalogPlan[];
}

export interface BillingCheckoutPayload {
  checkoutId: string;
  checkoutUrl: string;
  planKey: string;
  priceId: string;
}

export interface BillingPortalPayload {
  sessionId: string;
  portalUrl: string;
}
