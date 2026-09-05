import type { AuthProvider, ProviderAuthResult, ProviderUserProfile } from '../../../backend/src/auth/provider.js';
import type {
  AuthRepository,
  EntitlementRecord,
  SessionRecord,
  SubscriptionWithEntitlements,
  UserRecord,
} from '../../../backend/src/db/auth-repository.js';
import type { PaddleClient, CheckoutSession, CreateCheckoutInput, CustomerPortalSession } from '../../../backend/src/billing/paddle-client.js';
import type {
  BillingRepository,
  BillingSubscriptionRecord,
  BillingUserRecord,
  BillingWebhookEventInsert,
  UpsertSubscriptionFromWebhookInput,
} from '../../../backend/src/db/billing-repository.js';
import type { EntitlementRepository, EntitlementSnapshot } from '../../../backend/src/db/entitlement-repository.js';
import { createApp } from '../../../backend/src/app.js';
import { makeEnv } from './helpers.js';

interface MockAuthState {
  usersByEmail: Map<string, { providerUserId: string; password: string; email: string }>;
  accessTokens: Map<string, { providerUserId: string; email: string; expiresAt: number }>;
  refreshTokens: Map<string, { providerUserId: string; email: string }>;
  resetRequests: string[];
  forceInvalidCredentials: boolean;
  forceUserValidationFailure: boolean;
}

function newToken(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

export class MockAuthProvider implements AuthProvider {
  private readonly state: MockAuthState = {
    usersByEmail: new Map(),
    accessTokens: new Map(),
    refreshTokens: new Map(),
    resetRequests: [],
    forceInvalidCredentials: false,
    forceUserValidationFailure: false,
  };

  setForceInvalidCredentials(enabled: boolean): void {
    this.state.forceInvalidCredentials = enabled;
  }

  setForceUserValidationFailure(enabled: boolean): void {
    this.state.forceUserValidationFailure = enabled;
  }

  getPasswordResetRequests(): string[] {
    return [...this.state.resetRequests];
  }

  issueBearerForTest(providerUserId: string, email: string): string {
    const token = newToken('bearer');
    this.state.accessTokens.set(token, {
      providerUserId,
      email,
      expiresAt: Date.now() + 3600 * 1000,
    });
    return token;
  }

  async signup(email: string, password: string): Promise<ProviderAuthResult> {
    if (this.state.forceInvalidCredentials) throw new Error('forced invalid credentials');
    if (this.state.usersByEmail.has(email)) throw new Error('user exists');

    const providerUserId = `provider_${crypto.randomUUID()}`;
    this.state.usersByEmail.set(email, { providerUserId, password, email });
    return this.issueTokens(providerUserId, email);
  }

  async login(email: string, password: string): Promise<ProviderAuthResult> {
    if (this.state.forceInvalidCredentials) throw new Error('forced invalid credentials');
    const user = this.state.usersByEmail.get(email);
    if (!user || user.password !== password) throw new Error('invalid credentials');
    return this.issueTokens(user.providerUserId, user.email);
  }

  async refresh(refreshToken: string): Promise<ProviderAuthResult> {
    const session = this.state.refreshTokens.get(refreshToken);
    if (!session) throw new Error('invalid refresh token');
    return this.issueTokens(session.providerUserId, session.email);
  }

  async getUser(accessToken: string): Promise<ProviderUserProfile> {
    if (this.state.forceUserValidationFailure) throw new Error('forced user validation failure');
    const session = this.state.accessTokens.get(accessToken);
    if (!session || session.expiresAt <= Date.now()) throw new Error('invalid access token');
    return { providerUserId: session.providerUserId, email: session.email };
  }

  async logout(accessToken: string): Promise<void> {
    this.state.accessTokens.delete(accessToken);
  }

  async requestPasswordReset(email: string): Promise<void> {
    this.state.resetRequests.push(email);
  }

  private issueTokens(providerUserId: string, email: string): ProviderAuthResult {
    const accessToken = newToken('access');
    const refreshToken = newToken('refresh');
    const expiresIn = 3600;

    this.state.accessTokens.set(accessToken, {
      providerUserId,
      email,
      expiresAt: Date.now() + expiresIn * 1000,
    });
    this.state.refreshTokens.set(refreshToken, { providerUserId, email });

    return {
      providerUserId,
      email,
      accessToken,
      refreshToken,
      accessTokenExpiresInSec: expiresIn,
    };
  }
}

export class InMemoryAuthRepository implements AuthRepository {
  usersByProvider = new Map<string, UserRecord>();
  sessionsByHash = new Map<string, SessionRecord>();
  subscriptionsByUser = new Map<string, { id: string; userId: string; status: string; planCode: string }>();
  entitlementsByUser = new Map<string, EntitlementRecord[]>();

  async upsertUserByProviderIdentity(providerUserId: string, email: string): Promise<UserRecord> {
    const existing = this.usersByProvider.get(providerUserId);
    if (existing) {
      const updated = { ...existing, email };
      this.usersByProvider.set(providerUserId, updated);
      return updated;
    }

    const created: UserRecord = { id: `user_${crypto.randomUUID()}`, providerUserId, email };
    this.usersByProvider.set(providerUserId, created);
    return created;
  }

  async createSession(session: SessionRecord): Promise<void> {
    this.sessionsByHash.set(session.sessionTokenHash, session);
  }

  async findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    return this.sessionsByHash.get(tokenHash) ?? null;
  }

  async updateSessionTokens(sessionId: string, encryptedAccessToken: string, encryptedRefreshToken: string, accessTokenExpiresAt: string): Promise<void> {
    for (const [hash, session] of this.sessionsByHash.entries()) {
      if (session.id !== sessionId) continue;
      this.sessionsByHash.set(hash, { ...session, encryptedAccessToken, encryptedRefreshToken, accessTokenExpiresAt });
      return;
    }
  }

  async revokeSession(sessionId: string): Promise<void> {
    for (const [hash, session] of this.sessionsByHash.entries()) {
      if (session.id !== sessionId) continue;
      this.sessionsByHash.set(hash, { ...session, revokedAt: new Date().toISOString() });
      return;
    }
  }

  async revokeSessionByTokenHash(tokenHash: string): Promise<void> {
    const session = this.sessionsByHash.get(tokenHash);
    if (!session) return;
    this.sessionsByHash.set(tokenHash, { ...session, revokedAt: new Date().toISOString() });
  }

  async ensureDefaultAccountRecords(userId: string): Promise<void> {
    if (!this.subscriptionsByUser.has(userId)) {
      this.subscriptionsByUser.set(userId, { id: `sub_${crypto.randomUUID()}`, userId, status: 'active', planCode: 'free' });
    }

    if (!this.entitlementsByUser.has(userId)) {
      const subscription = this.subscriptionsByUser.get(userId)!;
      this.entitlementsByUser.set(userId, [{
        id: `ent_${crypto.randomUUID()}`,
        userId,
        subscriptionId: subscription.id,
        entitlementKey: 'core.recording',
        status: 'active',
      }]);
    }
  }

  async getSubscriptionWithEntitlementsForUser(userId: string): Promise<SubscriptionWithEntitlements> {
    const subscription = this.subscriptionsByUser.get(userId);
    return {
      subscription: subscription ? { id: subscription.id, userId: subscription.userId, status: subscription.status, planCode: subscription.planCode } : null,
      entitlements: [...(this.entitlementsByUser.get(userId) ?? [])],
    };
  }
}

export class MockPaddleClient implements PaddleClient {
  createdCheckouts: CreateCheckoutInput[] = [];
  createdPortalSessions: Array<{ customerId: string; subscriptionIds: string[] }> = [];

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    this.createdCheckouts.push(input);
    return {
      checkoutId: `txn_${crypto.randomUUID()}`,
      checkoutUrl: `https://sandbox-checkout.paddle.com/checkout/${crypto.randomUUID()}`,
    };
  }

  async createCustomerPortalSession(customerId: string, subscriptionIds: string[]): Promise<CustomerPortalSession> {
    this.createdPortalSessions.push({ customerId, subscriptionIds });
    return {
      sessionId: `cps_${crypto.randomUUID()}`,
      portalUrl: `https://sandbox-customer-portal.paddle.com/session/${crypto.randomUUID()}`,
    };
  }

  async readFormattedPrice(priceId: string, _countryCode: string | null): Promise<string | null> {
    if (priceId.includes('yearly')) return '$400';
    if (priceId.includes('monthly')) return '$40';
    return null;
  }
}

export class InMemoryBillingRepository implements BillingRepository {
  constructor(private readonly authRepo: InMemoryAuthRepository, private readonly configuredPriceIds: Record<string, string>) {}

  usersPaddleCustomer = new Map<string, string>();
  webhookEvents = new Map<string, { processedAt: string | null; error: string | null; claimed: boolean }>();
  subscriptionsByPaddleId = new Map<string, BillingSubscriptionRecord>();
  paidEntitlementByUser = new Map<string, { subscriptionId: string; enabled: boolean }>();

  async findUserById(userId: string): Promise<BillingUserRecord | null> {
    const user = [...this.authRepo.usersByProvider.values()].find((entry) => entry.id === userId);
    if (!user) return null;
    return { id: user.id, email: user.email, paddleCustomerId: this.usersPaddleCustomer.get(user.id) ?? null };
  }

  async findUserByEmail(email: string): Promise<BillingUserRecord | null> {
    const user = [...this.authRepo.usersByProvider.values()].find((entry) => entry.email === email);
    if (!user) return null;
    return { id: user.id, email: user.email, paddleCustomerId: this.usersPaddleCustomer.get(user.id) ?? null };
  }

  async findUserByPaddleCustomerId(paddleCustomerId: string): Promise<BillingUserRecord | null> {
    const userId = [...this.usersPaddleCustomer.entries()].find(([, value]) => value === paddleCustomerId)?.[0];
    if (!userId) return null;
    return this.findUserById(userId);
  }

  async setUserPaddleCustomerId(userId: string, paddleCustomerId: string): Promise<void> {
    this.usersPaddleCustomer.set(userId, paddleCustomerId);
  }

  async getPriceIdForPlan(planCode: string): Promise<string | null> {
    return this.configuredPriceIds[planCode] ?? null;
  }

  async insertWebhookEventIfNew(input: BillingWebhookEventInsert): Promise<{ shouldProcess: boolean; duplicate: boolean }> {
    const existing = this.webhookEvents.get(input.eventId);
    if (!existing) {
      this.webhookEvents.set(input.eventId, { processedAt: null, error: null, claimed: true });
      return { shouldProcess: true, duplicate: false };
    }

    if (existing.processedAt || existing.claimed) {
      return { shouldProcess: false, duplicate: true };
    }

    this.webhookEvents.set(input.eventId, { processedAt: null, error: null, claimed: true });
    return { shouldProcess: true, duplicate: false };
  }

  async markWebhookProcessed(eventId: string): Promise<void> {
    const entry = this.webhookEvents.get(eventId);
    if (!entry) return;
    this.webhookEvents.set(eventId, { processedAt: new Date().toISOString(), error: null, claimed: false });
  }

  async markWebhookFailed(eventId: string, errorMessage: string): Promise<void> {
    const entry = this.webhookEvents.get(eventId);
    if (!entry) return;
    this.webhookEvents.set(eventId, { processedAt: entry.processedAt, error: errorMessage, claimed: false });
  }

  async getSubscriptionByPaddleId(paddleSubscriptionId: string): Promise<BillingSubscriptionRecord | null> {
    return this.subscriptionsByPaddleId.get(paddleSubscriptionId) ?? null;
  }

  async upsertSubscriptionFromWebhook(input: UpsertSubscriptionFromWebhookInput): Promise<{ applied: boolean; subscriptionId: string }> {
    const existing = this.subscriptionsByPaddleId.get(input.paddleSubscriptionId);
    if (existing?.lastEventTime && new Date(existing.lastEventTime).getTime() > new Date(input.occurredAt).getTime()) {
      return { applied: false, subscriptionId: existing.id };
    }

    const subscription: BillingSubscriptionRecord = {
      id: existing?.id ?? `sub_${crypto.randomUUID()}`,
      userId: input.userId,
      status: input.status,
      planCode: input.planCode,
      provider: 'paddle',
      paddleSubscriptionId: input.paddleSubscriptionId,
      paddleCustomerId: input.paddleCustomerId,
      paddlePriceId: input.paddlePriceId,
      paddleProductId: input.paddleProductId,
      currentPeriodStartsAt: input.currentPeriodStartsAt,
      currentPeriodEndsAt: input.currentPeriodEndsAt,
      firstBilledAt: input.firstBilledAt,
      nextBilledAt: input.nextBilledAt,
      canceledAt: input.canceledAt,
      pausedAt: input.pausedAt,
      pastDueAt: input.pastDueAt,
      scheduledChangeAction: input.scheduledChangeAction,
      scheduledChangeEffectiveAt: input.scheduledChangeEffectiveAt,
      scheduledChangeResumeAt: input.scheduledChangeResumeAt,
      lastEventTime: input.occurredAt,
    };

    this.subscriptionsByPaddleId.set(input.paddleSubscriptionId, subscription);
    return { applied: true, subscriptionId: subscription.id };
  }

  async listSubscriptionsByUserId(userId: string): Promise<BillingSubscriptionRecord[]> {
    return [...this.subscriptionsByPaddleId.values()]
      .filter((subscription) => subscription.userId === userId)
      .sort((a, b) => Date.parse(b.lastEventTime ?? '1970-01-01T00:00:00.000Z') - Date.parse(a.lastEventTime ?? '1970-01-01T00:00:00.000Z'));
  }

  async setPaidEntitlement(userId: string, subscriptionId: string, enabled: boolean): Promise<void> {
    this.paidEntitlementByUser.set(userId, { subscriptionId, enabled });
  }
}

export class InMemoryEntitlementRepository implements EntitlementRepository {
  constructor(private readonly authRepo: InMemoryAuthRepository, private readonly billingRepo: InMemoryBillingRepository) {}

  revokedUsers = new Map<string, { revokedAt: string; reason: string | null }>();

  async getSnapshotForUser(userId: string): Promise<EntitlementSnapshot | null> {
    const user = [...this.authRepo.usersByProvider.values()].find((entry) => entry.id === userId);
    if (!user) return null;

    const revoked = this.revokedUsers.get(userId);
    const subscription = [...this.billingRepo.subscriptionsByPaddleId.values()]
      .filter((entry) => entry.userId === userId)
      .sort((a, b) => Date.parse(b.lastEventTime ?? '1970-01-01T00:00:00.000Z') - Date.parse(a.lastEventTime ?? '1970-01-01T00:00:00.000Z'))[0];

    const paid = this.billingRepo.paidEntitlementByUser.get(userId);

    return {
      user: {
        id: userId,
        accessRevokedAt: revoked?.revokedAt ?? null,
        accessRevocationReason: revoked?.reason ?? null,
        updatedAt: revoked?.revokedAt ?? new Date().toISOString(),
      },
      subscription: subscription
        ? {
            id: subscription.id,
            status: subscription.status,
            planCode: subscription.planCode,
            currentPeriodEndsAt: subscription.currentPeriodEndsAt,
            updatedAt: subscription.lastEventTime ?? new Date().toISOString(),
          }
        : null,
      paidEntitlement: paid
        ? {
            status: paid.enabled ? 'active' : 'inactive',
            updatedAt: new Date().toISOString(),
          }
        : null,
    };
  }
}

export function createAuthTestApp(provider: MockAuthProvider, repository: InMemoryAuthRepository) {
  const paddle = new MockPaddleClient();
  const billingRepository = new InMemoryBillingRepository(repository, { 'pro-monthly': 'pri_123' });
  const entitlementRepository = new InMemoryEntitlementRepository(repository, billingRepository);

  const app = createApp({
    createAuthProvider: () => provider,
    createAuthRepository: () => repository,
    createPaddleClient: () => paddle,
    createBillingRepository: () => billingRepository,
    createEntitlementRepository: () => entitlementRepository,
  });

  return { app, env: makeEnv(), paddle, billingRepository, entitlementRepository };
}

export function createBillingTestApp() {
  const provider = new MockAuthProvider();
  const authRepository = new InMemoryAuthRepository();
  const paddle = new MockPaddleClient();
  const billingRepository = new InMemoryBillingRepository(authRepository, { 'pro-monthly': 'pri_123' });
  const entitlementRepository = new InMemoryEntitlementRepository(authRepository, billingRepository);

  const app = createApp({
    createAuthProvider: () => provider,
    createAuthRepository: () => authRepository,
    createPaddleClient: () => paddle,
    createBillingRepository: () => billingRepository,
    createEntitlementRepository: () => entitlementRepository,
  });

  return {
    app,
    env: makeEnv(),
    provider,
    authRepository,
    paddle,
    billingRepository,
    entitlementRepository,
  };
}
