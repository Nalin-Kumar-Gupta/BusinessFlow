import type { BillingCatalogPrice } from '../../core/billing.js';

export function readFormattedPriceLabel(price: BillingCatalogPrice | undefined): string | null {
  if (!price) return null;
  const unknownPrice = price as unknown as Record<string, unknown>;
  const formattedCandidates = [
    unknownPrice['formattedPrice'],
    unknownPrice['formatted_price'],
    unknownPrice['formattedUnitPrice'],
    unknownPrice['formatted_unit_price'],
    unknownPrice['displayPrice'],
    unknownPrice['display_price'],
  ];
  for (const candidate of formattedCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}
