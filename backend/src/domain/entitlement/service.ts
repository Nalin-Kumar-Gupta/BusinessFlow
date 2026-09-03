import { ApiError } from '../../errors/api-error.js';
import type { AuthenticatedIdentity } from '../../types.js';
import type { EntitlementRepository, EntitlementSnapshot } from '../../db/entitlement-repository.js';
import type { EntitlementEvaluation, EntitlementState } from './types.js';

interface EntitlementPolicy {
  refreshAfterSeconds: number;
  cacheMaxAgeSeconds: number;
  offlineGraceSeconds: number;
}

function toMillis(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function computeEntitlementState(snapshot: EntitlementSnapshot, nowMs: number): {
  state: EntitlementState;
  granted: boolean;
  plan: string;
  accessUntil: string | null;
} {
  if (snapshot.user.accessRevokedAt || snapshot.paidEntitlement?.status === 'revoked') {
    return {
      state: 'revoked',
      granted: false,
      plan: snapshot.subscription?.planCode ?? 'free',
      accessUntil: null,
    };
  }

  const subscription = snapshot.subscription;
  if (!subscription || subscription.planCode === 'free') {
    return {
      state: 'free',
      granted: false,
      plan: 'free',
      accessUntil: null,
    };
  }

  const periodEndMs = toMillis(subscription.currentPeriodEndsAt);
  const isExpiredByTime = periodEndMs !== null && periodEndMs <= nowMs;

  if (isExpiredByTime) {
    return {
      state: 'expired',
      granted: false,
      plan: subscription.planCode,
      accessUntil: subscription.currentPeriodEndsAt,
    };
  }

  if (subscription.status === 'trialing') {
    return {
      state: 'trial',
      granted: true,
      plan: subscription.planCode,
      accessUntil: subscription.currentPeriodEndsAt,
    };
  }

  if (subscription.status === 'active') {
    return {
      state: 'paid_active',
      granted: true,
      plan: subscription.planCode,
      accessUntil: subscription.currentPeriodEndsAt,
    };
  }

  if (subscription.status === 'canceled') {
    return {
      state: 'canceled_grace',
      granted: false,
      plan: subscription.planCode,
      accessUntil: subscription.currentPeriodEndsAt,
    };
  }

  if (subscription.status === 'past_due') {
    return {
      state: 'past_due',
      granted: false,
      plan: subscription.planCode,
      accessUntil: subscription.currentPeriodEndsAt,
    };
  }

  if (subscription.status === 'paused') {
    return {
      state: 'paused',
      granted: false,
      plan: subscription.planCode,
      accessUntil: subscription.currentPeriodEndsAt,
    };
  }

  return {
    state: 'expired',
    granted: false,
    plan: subscription.planCode,
    accessUntil: subscription.currentPeriodEndsAt,
  };
}

function resolveVersion(snapshot: EntitlementSnapshot, checkedAt: string): string {
  const candidates = [
    snapshot.user.updatedAt,
    snapshot.subscription?.updatedAt,
    snapshot.paidEntitlement?.updatedAt,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  const latest = candidates.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? checkedAt;
  return `ent_v1_${latest}`;
}

export class EntitlementService {
  constructor(
    private readonly repository: EntitlementRepository,
    private readonly policy: EntitlementPolicy,
  ) {}

  async evaluate(identity: AuthenticatedIdentity): Promise<EntitlementEvaluation> {
    const snapshot = await this.repository.getSnapshotForUser(identity.userId);
    if (!snapshot) {
      throw new ApiError({
        code: 'AUTH_USER_NOT_FOUND',
        status: 401,
        message: 'Authenticated user is no longer available',
      });
    }

    const checkedAt = new Date().toISOString();
    const computed = computeEntitlementState(snapshot, Date.now());

    return {
      userId: identity.userId,
      plan: computed.plan,
      access: {
        granted: computed.granted,
        state: computed.state,
        accessUntil: computed.accessUntil,
      },
      authorization: {
        checkedAt,
        refreshAfterSeconds: this.policy.refreshAfterSeconds,
        cacheMaxAgeSeconds: this.policy.cacheMaxAgeSeconds,
        offlineGraceSeconds: this.policy.offlineGraceSeconds,
      },
      entitlementVersion: resolveVersion(snapshot, checkedAt),
    };
  }

  async requirePaidAccess(identity: AuthenticatedIdentity): Promise<EntitlementEvaluation> {
    const evaluation = await this.evaluate(identity);
    if (!evaluation.access.granted) {
      throw new ApiError({
        code: 'AUTHZ_ENTITLEMENT_REQUIRED',
        status: 403,
        message: 'Paid entitlement is required for this operation',
        details: {
          state: evaluation.access.state,
          plan: evaluation.plan,
        },
      });
    }
    return evaluation;
  }
}
