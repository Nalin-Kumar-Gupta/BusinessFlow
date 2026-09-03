import { ApiError } from '../errors/api-error.js';

export interface EntitlementSubscriptionSnapshot {
  id: string;
  status: string;
  planCode: string;
  currentPeriodEndsAt: string | null;
  updatedAt: string;
}

export interface EntitlementRecordSnapshot {
  status: string;
  updatedAt: string;
}

export interface EntitlementUserSnapshot {
  id: string;
  accessRevokedAt: string | null;
  accessRevocationReason: string | null;
  updatedAt: string;
}

export interface EntitlementSnapshot {
  user: EntitlementUserSnapshot;
  subscription: EntitlementSubscriptionSnapshot | null;
  paidEntitlement: EntitlementRecordSnapshot | null;
}

export interface EntitlementRepository {
  getSnapshotForUser: (userId: string) => Promise<EntitlementSnapshot | null>;
}

interface UserRow {
  id: string;
  access_revoked_at: string | null;
  access_revocation_reason: string | null;
  updated_at: string;
}

interface SubscriptionRow {
  id: string;
  status: string;
  plan_code: string;
  current_period_ends_at: string | null;
  updated_at: string;
}

interface EntitlementRow {
  status: string;
  updated_at: string;
}

export class D1EntitlementRepository implements EntitlementRepository {
  private readonly db: D1Database;

  constructor(db?: D1Database) {
    if (!db) {
      throw new ApiError({
        code: 'DB_NOT_CONFIGURED',
        status: 500,
        message: 'D1 database binding is not configured',
      });
    }
    this.db = db;
  }

  async getSnapshotForUser(userId: string): Promise<EntitlementSnapshot | null> {
    const user = await this.db
      .prepare('SELECT id, access_revoked_at, access_revocation_reason, updated_at FROM users WHERE id = ?1')
      .bind(userId)
      .first<UserRow>();

    if (!user) return null;

    const subscription = await this.db
      .prepare(`
        SELECT id, status, plan_code, current_period_ends_at, updated_at
        FROM subscriptions
        WHERE user_id = ?1
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      `)
      .bind(userId)
      .first<SubscriptionRow>();

    const paidEntitlement = await this.db
      .prepare('SELECT status, updated_at FROM entitlements WHERE user_id = ?1 AND entitlement_key = ?2 LIMIT 1')
      .bind(userId, 'billing.paid')
      .first<EntitlementRow>();

    return {
      user: {
        id: user.id,
        accessRevokedAt: user.access_revoked_at,
        accessRevocationReason: user.access_revocation_reason,
        updatedAt: user.updated_at,
      },
      subscription: subscription
        ? {
            id: subscription.id,
            status: subscription.status,
            planCode: subscription.plan_code,
            currentPeriodEndsAt: subscription.current_period_ends_at,
            updatedAt: subscription.updated_at,
          }
        : null,
      paidEntitlement: paidEntitlement
        ? {
            status: paidEntitlement.status,
            updatedAt: paidEntitlement.updated_at,
          }
        : null,
    };
  }
}
