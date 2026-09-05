export interface ProviderAuthResult {
  providerUserId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresInSec: number;
}

export interface ProviderUserProfile {
  providerUserId: string;
  email: string;
}

export interface AuthProvider {
  signup: (email: string, password: string) => Promise<ProviderAuthResult>;
  login: (email: string, password: string) => Promise<ProviderAuthResult>;
  refresh: (refreshToken: string) => Promise<ProviderAuthResult>;
  getUser: (accessToken: string) => Promise<ProviderUserProfile>;
  logout: (accessToken: string) => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
}
