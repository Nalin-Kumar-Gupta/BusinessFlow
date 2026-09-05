import { describe, expect, it } from 'vitest';

import type { AuthStatusPayload } from '../../../src/core/auth.js';
import {
  humanizeToken,
  resolveAccountIdentityCaption,
  resolveAccountPlanLabel,
  resolveTrialDaysLeft,
} from '../../../src/ui/dashboard/account-ux.js';

const baseStatus: AuthStatusPayload = {
  state: 'access_active',
  backendBaseUrl: 'https://api.example.com',
  signedIn: true,
  user: { userId: 'user-1', email: 'qa@example.com' },
  entitlement: {
    plan: 'pro_monthly',
    granted: true,
    state: 'trial_active',
    accessUntil: '2030-01-10T00:00:00.000Z',
    checkedAt: '2030-01-01T00:00:00.000Z',
    entitlementVersion: 'v1',
    stale: false,
  },
  message: 'OK',
  checkedAt: '2030-01-01T00:00:00.000Z',
};

describe('account ux helpers', () => {
  it('humanizes snake/slug tokens', () => {
    expect(humanizeToken('access_active')).toBe('Access active');
    expect(humanizeToken('PRO-MONTHLY')).toBe('Pro monthly');
    expect(humanizeToken('')).toBe('—');
  });

  it('resolves trial days safely', () => {
    const now = Date.parse('2030-01-07T00:00:00.000Z');
    expect(resolveTrialDaysLeft('2030-01-10T00:00:00.000Z', now)).toBe(3);
    expect(resolveTrialDaysLeft('bad-date', now)).toBeNull();
    expect(resolveTrialDaysLeft(null, now)).toBeNull();
  });

  it('resolves account plan labels for signed-in and signed-out users', () => {
    expect(resolveAccountPlanLabel(baseStatus)).toBe('Pro monthly');
    expect(resolveAccountPlanLabel({ ...baseStatus, entitlement: null })).toBe('Free');
    expect(resolveAccountPlanLabel({ ...baseStatus, signedIn: false, user: null, entitlement: null })).toBe('Not signed in');
  });

  it('resolves identity caption with loading and auth state', () => {
    expect(resolveAccountIdentityCaption(baseStatus, true)).toBe('Checking account access…');
    expect(resolveAccountIdentityCaption({ ...baseStatus, signedIn: false, user: null }, false)).toBe('Sign in to access billing and plan details.');
    expect(resolveAccountIdentityCaption(baseStatus, false)).toBe('Access active');
  });
});
