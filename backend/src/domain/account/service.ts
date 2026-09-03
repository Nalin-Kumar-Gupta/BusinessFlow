import type { AuthRepository } from '../../db/auth-repository.js';
import type { AuthenticatedIdentity } from '../../types.js';

export class AccountService {
  constructor(private readonly repository: AuthRepository) {}

  async getAccountSnapshot(identity: AuthenticatedIdentity): Promise<{
    user: { id: string; email: string; providerUserId: string };
    subscription: { id: string; status: string; planCode: string } | null;
    entitlements: Array<{ key: string; status: string }>;
  }> {
    const account = await this.repository.getSubscriptionWithEntitlementsForUser(identity.userId);

    return {
      user: {
        id: identity.userId,
        email: identity.email,
        providerUserId: identity.providerUserId,
      },
      subscription: account.subscription
        ? {
            id: account.subscription.id,
            status: account.subscription.status,
            planCode: account.subscription.planCode,
          }
        : null,
      entitlements: account.entitlements.map((item) => ({
        key: item.entitlementKey,
        status: item.status,
      })),
    };
  }
}
