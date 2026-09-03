import { ApiError } from '../errors/api-error.js';

export interface UserRecord {
  id: string;
  providerUserId: string;
  email: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  providerUserId: string;
  email: string;
  sessionTokenHash: string;
  encryptedRefreshToken: string;
  encryptedAccessToken: string;
  accessTokenExpiresAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface SubscriptionRecord {
  id: string;
  userId: string;
  status: string;
  planCode: string;
}

export interface EntitlementRecord {
  id: string;
  userId: string;
  subscriptionId: string;
  entitlementKey: string;
  status: string;
}

export interface SubscriptionWithEntitlements {
  subscription: SubscriptionRecord | null;
  entitlements: EntitlementRecord[];
}

export interface AuthRepository {
  upsertUserByProviderIdentity: (providerUserId: string, email: string) => Promise<UserRecord>;
  createSession: (session: SessionRecord) => Promise<void>;
  findSessionByTokenHash: (tokenHash: string) => Promise<SessionRecord | null>;
  updateSessionTokens: (sessionId: string, encryptedAccessToken: string, encryptedRefreshToken: string, accessTokenExpiresAt: string) => Promise<void>;
  revokeSession: (sessionId: string) => Promise<void>;
  revokeSessionByTokenHash: (tokenHash: string) => Promise<void>;
  ensureDefaultAccountRecords: (userId: string) => Promise<void>;
  getSubscriptionWithEntitlementsForUser: (userId: string) => Promise<SubscriptionWithEntitlements>;
}

interface UserRow {
  id: string;
  provider_user_id: string;
  email: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  provider_user_id: string;
  email: string;
  session_token_hash: string;
  encrypted_refresh_token: string;
  encrypted_access_token: string;
  access_token_expires_at: string;
  expires_at: string;
  revoked_at: string | null;
}

interface SubscriptionRow {
  id: string;
  user_id: string;
  status: string;
  plan_code: string;
}

interface EntitlementRow {
  id: string;
  user_id: string;
  subscription_id: string;
  entitlement_key: string;
  status: string;
}

function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    providerUserId: row.provider_user_id,
    email: row.email,
    sessionTokenHash: row.session_token_hash,
    encryptedRefreshToken: row.encrypted_refresh_token,
    encryptedAccessToken: row.encrypted_access_token,
    accessTokenExpiresAt: row.access_token_expires_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

function toSubscriptionRecord(row: SubscriptionRow): SubscriptionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    planCode: row.plan_code,
  };
}

function toEntitlementRecord(row: EntitlementRow): EntitlementRecord {
  return {
    id: row.id,
    userId: row.user_id,
    subscriptionId: row.subscription_id,
    entitlementKey: row.entitlement_key,
    status: row.status,
  };
}

export class D1AuthRepository implements AuthRepository {
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

  async upsertUserByProviderIdentity(providerUserId: string, email: string): Promise<UserRecord> {
    const existing = await this.db
      .prepare('SELECT id, provider_user_id, email FROM users WHERE provider_user_id = ?1')
      .bind(providerUserId)
      .first<UserRow>();

    if (existing) {
      if (existing.email !== email) {
        await this.db.prepare('UPDATE users SET email = ?1, updated_at = datetime(\'now\') WHERE id = ?2').bind(email, existing.id).run();
      }
      return {
        id: existing.id,
        providerUserId,
        email,
      };
    }

    const id = crypto.randomUUID();
    await this.db
      .prepare('INSERT INTO users (id, provider_user_id, email) VALUES (?1, ?2, ?3)')
      .bind(id, providerUserId, email)
      .run();

    return { id, providerUserId, email };
  }

  async createSession(session: SessionRecord): Promise<void> {
    await this.db
      .prepare(`
        INSERT INTO auth_sessions (
          id, user_id, provider_user_id, email, session_token_hash,
          encrypted_refresh_token, encrypted_access_token,
          access_token_expires_at, expires_at, revoked_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      `)
      .bind(
        session.id,
        session.userId,
        session.providerUserId,
        session.email,
        session.sessionTokenHash,
        session.encryptedRefreshToken,
        session.encryptedAccessToken,
        session.accessTokenExpiresAt,
        session.expiresAt,
        session.revokedAt,
      )
      .run();
  }

  async findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const row = await this.db
      .prepare(`
        SELECT id, user_id, provider_user_id, email, session_token_hash,
               encrypted_refresh_token, encrypted_access_token,
               access_token_expires_at, expires_at, revoked_at
        FROM auth_sessions
        WHERE session_token_hash = ?1
      `)
      .bind(tokenHash)
      .first<SessionRow>();

    return row ? toSessionRecord(row) : null;
  }

  async updateSessionTokens(
    sessionId: string,
    encryptedAccessToken: string,
    encryptedRefreshToken: string,
    accessTokenExpiresAt: string,
  ): Promise<void> {
    await this.db
      .prepare(`
        UPDATE auth_sessions
        SET encrypted_access_token = ?1,
            encrypted_refresh_token = ?2,
            access_token_expires_at = ?3,
            updated_at = datetime('now')
        WHERE id = ?4
      `)
      .bind(encryptedAccessToken, encryptedRefreshToken, accessTokenExpiresAt, sessionId)
      .run();
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.db
      .prepare("UPDATE auth_sessions SET revoked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1")
      .bind(sessionId)
      .run();
  }

  async revokeSessionByTokenHash(tokenHash: string): Promise<void> {
    await this.db
      .prepare("UPDATE auth_sessions SET revoked_at = datetime('now'), updated_at = datetime('now') WHERE session_token_hash = ?1")
      .bind(tokenHash)
      .run();
  }

  async ensureDefaultAccountRecords(userId: string): Promise<void> {
    const existingSubscription = await this.db
      .prepare('SELECT id FROM subscriptions WHERE user_id = ?1 ORDER BY created_at ASC LIMIT 1')
      .bind(userId)
      .first<{ id: string }>();

    let subscriptionId = existingSubscription?.id;
    if (!subscriptionId) {
      subscriptionId = crypto.randomUUID();
      await this.db
        .prepare('INSERT INTO subscriptions (id, user_id, status, plan_code) VALUES (?1, ?2, ?3, ?4)')
        .bind(subscriptionId, userId, 'active', 'free')
        .run();
    }

    await this.db
      .prepare(`
        INSERT OR IGNORE INTO entitlements (id, user_id, subscription_id, entitlement_key, status)
        VALUES (?1, ?2, ?3, ?4, ?5)
      `)
      .bind(crypto.randomUUID(), userId, subscriptionId, 'core.recording', 'active')
      .run();
  }

  async getSubscriptionWithEntitlementsForUser(userId: string): Promise<SubscriptionWithEntitlements> {
    const subscriptionRow = await this.db
      .prepare('SELECT id, user_id, status, plan_code FROM subscriptions WHERE user_id = ?1 ORDER BY updated_at DESC, created_at DESC LIMIT 1')
      .bind(userId)
      .first<SubscriptionRow>();

    if (!subscriptionRow) {
      return { subscription: null, entitlements: [] };
    }

    const entitlementsResult = await this.db
      .prepare('SELECT id, user_id, subscription_id, entitlement_key, status FROM entitlements WHERE user_id = ?1 ORDER BY entitlement_key ASC')
      .bind(userId)
      .all<EntitlementRow>();

    return {
      subscription: toSubscriptionRecord(subscriptionRow),
      entitlements: (entitlementsResult.results ?? []).map(toEntitlementRecord),
    };
  }
}
