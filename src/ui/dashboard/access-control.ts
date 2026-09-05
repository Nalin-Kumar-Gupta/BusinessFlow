import type { AuthStatusPayload } from '../../core/auth.js';

export type WorkspaceFeature =
  | 'workspace.dashboard'
  | 'workspace.features'
  | 'workspace.testCases'
  | 'workspace.history'
  | 'workspace.reporting';

export type AccessPlan = 'free' | 'pro';

export interface AccessContext {
  signedIn: boolean;
  plan: AccessPlan;
  billingInterval: 'monthly' | 'yearly' | null;
  entitlementState: string | null;
  authState: AuthStatusPayload['state'];
}

export function deriveAccessContext(status: AuthStatusPayload | null): AccessContext {
  const entitlementPlan = status?.entitlement?.plan?.toLowerCase() ?? '';
  const isPro = entitlementPlan.includes('pro');

  return {
    signedIn: status?.signedIn === true,
    plan: isPro ? 'pro' : 'free',
    billingInterval: entitlementPlan.includes('yearly')
      ? 'yearly'
      : entitlementPlan.includes('monthly')
        ? 'monthly'
        : null,
    entitlementState: status?.entitlement?.state ?? null,
    authState: status?.state ?? 'signed_out',
  };
}

/**
 * Future gate entry-point.
 * Keep feature policy centralized here instead of scattering plan checks in views.
 */
export function canAccess(feature: WorkspaceFeature, access: AccessContext): boolean {
  if (access.plan === 'pro') return true;

  switch (feature) {
    case 'workspace.dashboard':
    case 'workspace.features':
    case 'workspace.testCases':
    case 'workspace.history':
    case 'workspace.reporting':
      return false;
    default:
      return false;
  }
}
