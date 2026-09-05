import { describe, expect, it } from 'vitest';

import { readFormattedPriceLabel } from '../../../src/ui/dashboard/pricing-ux.js';

describe('pricing ux helpers', () => {
  it('uses formatted values returned by catalog price payload when available', () => {
    expect(readFormattedPriceLabel({ planKey: 'starter-monthly', priceId: 'pri_1', trialDays: 7, formattedPrice: '€9' } as never)).toBe('€9');
    expect(readFormattedPriceLabel({ planKey: 'starter-monthly', priceId: 'pri_1', trialDays: 7, formatted_price: '£10' } as never)).toBe('£10');
  });

  it('returns null when no formatted value is provided by backend payload', () => {
    expect(readFormattedPriceLabel({ planKey: 'pro-monthly', priceId: 'pri_2', trialDays: 7 } as never)).toBeNull();
  });
});
