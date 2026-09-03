import type { AuthenticatedIdentity } from '../../types.js';

export interface AuthenticatedSession {
  identity: AuthenticatedIdentity;
  sessionToken: string;
}

export interface PublicUserProfile {
  userId: string;
  email: string;
  providerUserId: string;
}
