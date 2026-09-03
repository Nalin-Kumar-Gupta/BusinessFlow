export type ExtensionAccessState =
  | 'signed_out'
  | 'signed_in'
  | 'checking_access'
  | 'access_active'
  | 'access_unavailable'
  | 'session_expired';

export interface EntitlementPayload {
  userId: string;
  plan: string;
  access: {
    granted: boolean;
    state: string;
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

export interface AuthStatusPayload {
  state: ExtensionAccessState;
  backendBaseUrl: string;
  signedIn: boolean;
  user: { userId: string; email: string } | null;
  entitlement: {
    plan: string;
    granted: boolean;
    state: string;
    accessUntil: string | null;
    checkedAt: string;
    entitlementVersion: string;
    stale: boolean;
  } | null;
  message: string;
  checkedAt: string;
}
