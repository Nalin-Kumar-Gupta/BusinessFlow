export type EntitlementState =
  | 'free'
  | 'paid_active'
  | 'trial'
  | 'canceled_grace'
  | 'expired'
  | 'past_due'
  | 'paused'
  | 'revoked';

export interface EntitlementEvaluation {
  userId: string;
  plan: string;
  access: {
    granted: boolean;
    state: EntitlementState;
    accessUntil: string | null;
  };
  authorization: {
    checkedAt: string;
    refreshAfterSeconds: number;
    cacheMaxAgeSeconds: number;
    offlineGraceSeconds: number;
  };
  entitlementVersion: string;
}
