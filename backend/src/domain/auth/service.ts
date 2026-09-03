import type { AuthContext, AuthenticatedIdentity } from '../../types.js';
import { ApiError } from '../../errors/api-error.js';
import type { AuthProvider } from '../../auth/provider.js';
import type { AuthRepository, SessionRecord } from '../../db/auth-repository.js';
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from '../../auth/crypto.js';
import type { PublicUserProfile } from './types.js';

interface AuthServiceOptions {
  sessionTtlSeconds: number;
  sessionEncryptionKey: string;
}

export class AuthService {
  constructor(
    private readonly provider: AuthProvider,
    private readonly repository: AuthRepository,
    private readonly options: AuthServiceOptions,
  ) {}

  async signup(email: string, password: string): Promise<{ profile: PublicUserProfile; sessionToken: string }> {
    try {
      const providerResult = await this.provider.signup(email, password);
      return this.createSessionFromProviderResult(providerResult);
    } catch (error) {
      throw this.normalizeProviderError(error, 'AUTH_SIGNUP_FAILED');
    }
  }

  async login(email: string, password: string): Promise<{ profile: PublicUserProfile; sessionToken: string }> {
    try {
      const providerResult = await this.provider.login(email, password);
      return this.createSessionFromProviderResult(providerResult);
    } catch (error) {
      throw this.normalizeProviderError(error, 'AUTH_INVALID_CREDENTIALS');
    }
  }

  async logout(auth: AuthContext): Promise<void> {
    if (auth.actorType !== 'session' || !auth.sessionToken) return;

    const tokenHash = await sha256Hex(auth.sessionToken);
    const session = await this.repository.findSessionByTokenHash(tokenHash);
    if (!session) return;

    try {
      const accessToken = await decryptSecret(session.encryptedAccessToken, this.options.sessionEncryptionKey);
      await this.provider.logout(accessToken);
    } catch {
      // best effort revoke upstream; local revoke always runs.
    }

    await this.repository.revokeSession(session.id);
  }

  async requireIdentity(auth: AuthContext): Promise<AuthenticatedIdentity> {
    if (auth.actorType === 'bearer' && auth.bearerToken) {
      let profile;
      try {
        profile = await this.provider.getUser(auth.bearerToken);
      } catch (error) {
        throw this.normalizeProviderError(error, 'AUTH_TOKEN_INVALID');
      }

      const user = await this.repository.upsertUserByProviderIdentity(profile.providerUserId, profile.email);
      await this.repository.ensureDefaultAccountRecords(user.id);
      return {
        userId: user.id,
        providerUserId: user.providerUserId,
        email: user.email,
        sessionId: 'bearer',
      };
    }

    if (auth.actorType !== 'session' || !auth.sessionToken) {
      throw new ApiError({
        code: 'AUTH_REQUIRED',
        status: 401,
        message: 'Authentication is required',
      });
    }

    const tokenHash = await sha256Hex(auth.sessionToken);
    const session = await this.repository.findSessionByTokenHash(tokenHash);
    if (!session || session.revokedAt) {
      throw new ApiError({
        code: 'AUTH_SESSION_INVALID',
        status: 401,
        message: 'Session is invalid or revoked',
      });
    }

    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      await this.repository.revokeSession(session.id);
      throw new ApiError({
        code: 'AUTH_SESSION_EXPIRED',
        status: 401,
        message: 'Session has expired',
      });
    }

    const hydrated = await this.hydrateSession(session);
    return {
      userId: hydrated.userId,
      providerUserId: hydrated.providerUserId,
      email: hydrated.email,
      sessionId: hydrated.id,
    };
  }

  private async hydrateSession(session: SessionRecord): Promise<SessionRecord> {
    const now = Date.now();
    let active = session;

    if (new Date(session.accessTokenExpiresAt).getTime() <= now + 5_000) {
      active = await this.refreshSessionTokens(session);
    }

    const accessToken = await decryptSecret(active.encryptedAccessToken, this.options.sessionEncryptionKey);
    let profile;
    try {
      profile = await this.provider.getUser(accessToken);
    } catch {
      const refreshed = await this.refreshSessionTokens(active);
      const refreshedToken = await decryptSecret(refreshed.encryptedAccessToken, this.options.sessionEncryptionKey);
      try {
        profile = await this.provider.getUser(refreshedToken);
      } catch (error) {
        await this.repository.revokeSession(refreshed.id);
        throw this.normalizeProviderError(error, 'AUTH_TOKEN_INVALID');
      }
      active = refreshed;
    }

    if (profile.providerUserId !== active.providerUserId) {
      await this.repository.revokeSession(active.id);
      throw new ApiError({
        code: 'AUTH_TOKEN_SUBJECT_MISMATCH',
        status: 401,
        message: 'Session identity mismatch detected',
      });
    }

    return {
      ...active,
      email: profile.email || active.email,
    };
  }

  private async refreshSessionTokens(session: SessionRecord): Promise<SessionRecord> {
    const refreshToken = await decryptSecret(session.encryptedRefreshToken, this.options.sessionEncryptionKey);
    let refreshed;
    try {
      refreshed = await this.provider.refresh(refreshToken);
    } catch (error) {
      await this.repository.revokeSession(session.id);
      throw this.normalizeProviderError(error, 'AUTH_SESSION_EXPIRED');
    }

    const encryptedAccessToken = await encryptSecret(refreshed.accessToken, this.options.sessionEncryptionKey);
    const encryptedRefreshToken = await encryptSecret(refreshed.refreshToken, this.options.sessionEncryptionKey);
    const accessTokenExpiresAt = new Date(Date.now() + refreshed.accessTokenExpiresInSec * 1000).toISOString();

    await this.repository.updateSessionTokens(session.id, encryptedAccessToken, encryptedRefreshToken, accessTokenExpiresAt);

    return {
      ...session,
      encryptedAccessToken,
      encryptedRefreshToken,
      accessTokenExpiresAt,
      email: refreshed.email || session.email,
      providerUserId: refreshed.providerUserId,
    };
  }

  private normalizeProviderError(error: unknown, fallbackCode: string): ApiError {
    if (error instanceof ApiError) return error;
    const isAuthFailure = fallbackCode.includes('CREDENTIALS')
      || fallbackCode.includes('SESSION')
      || fallbackCode.includes('TOKEN')
      || fallbackCode.includes('INVALID');

    return new ApiError({
      code: fallbackCode,
      status: isAuthFailure ? 401 : 502,
      message: 'Authentication provider rejected the request',
    });
  }

  private async createSessionFromProviderResult(providerResult: {
    providerUserId: string;
    email: string;
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresInSec: number;
  }): Promise<{ profile: PublicUserProfile; sessionToken: string }> {
    const user = await this.repository.upsertUserByProviderIdentity(providerResult.providerUserId, providerResult.email);
    await this.repository.ensureDefaultAccountRecords(user.id);

    const sessionToken = randomToken();
    const sessionTokenHash = await sha256Hex(sessionToken);
    const encryptedAccessToken = await encryptSecret(providerResult.accessToken, this.options.sessionEncryptionKey);
    const encryptedRefreshToken = await encryptSecret(providerResult.refreshToken, this.options.sessionEncryptionKey);

    const now = Date.now();
    const expiresAt = new Date(now + this.options.sessionTtlSeconds * 1000).toISOString();
    const accessTokenExpiresAt = new Date(now + providerResult.accessTokenExpiresInSec * 1000).toISOString();

    await this.repository.createSession({
      id: crypto.randomUUID(),
      userId: user.id,
      providerUserId: user.providerUserId,
      email: user.email,
      sessionTokenHash,
      encryptedRefreshToken,
      encryptedAccessToken,
      accessTokenExpiresAt,
      expiresAt,
      revokedAt: null,
    });

    return {
      profile: {
        userId: user.id,
        providerUserId: user.providerUserId,
        email: user.email,
      },
      sessionToken,
    };
  }
}
