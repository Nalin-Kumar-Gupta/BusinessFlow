import type { AuthStatusPayload } from '../../core/auth.js';

export type AccountMessageTone = 'info' | 'ok' | 'error';

export interface AccountInlineMessage {
  tone: AccountMessageTone;
  text: string;
}

export function humanizeToken(value: string | null | undefined): string {
  if (!value) return '—';
  const cleaned = value.replace(/[_-]+/g, ' ').trim();
  if (!cleaned) return '—';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

export function resolveTrialDaysLeft(accessUntil: string | null | undefined, nowMs = Date.now()): number | null {
  if (!accessUntil) return null;
  const accessUntilMs = Date.parse(accessUntil);
  if (!Number.isFinite(accessUntilMs)) return null;
  return Math.max(0, Math.ceil((accessUntilMs - nowMs) / (1000 * 60 * 60 * 24)));
}

export function resolveAccountPlanLabel(authStatus: AuthStatusPayload | null): string {
  const plan = authStatus?.entitlement?.plan?.trim();
  if (!plan) return authStatus?.signedIn ? 'Free' : 'Not signed in';
  return humanizeToken(plan);
}

export function resolveAccountIdentityCaption(authStatus: AuthStatusPayload | null, isAuthLoading: boolean): string {
  if (isAuthLoading) return 'Checking account access…';
  if (!authStatus?.signedIn) return 'Sign in to access billing and plan details.';
  return humanizeToken(authStatus.state);
}
