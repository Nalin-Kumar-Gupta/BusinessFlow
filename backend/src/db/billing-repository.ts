import { ApiError } from '../errors/api-error.js';

export interface BillingUserRecord {
  id: string;
  email: string;
  paddleCustomerId: string | null;
}

export interface BillingSubscriptionRecord {
  id: string;
  userId: string;
  status: string;
  planCode: string;
  provider: string;
  paddleSubscriptionId: string | null;
  paddleCustomerId: string | null;
  paddlePriceId: string | null;
  paddleProductId: string | null;
  currentPeriodStartsAt: string | null;
  currentPeriodEndsAt: string | null;
  firstBilledAt: string | null;
  nextBilledAt: string | null;
  canceledAt: string | null;
  pausedAt: string | null;
  pastDueAt: string | null;
  scheduledChangeAction: string | null;
  scheduledChangeEffectiveAt: string | null;
  scheduledChangeResumeAt: string | null;
  lastEventTime: string | null;
}

export interface BillingWebhookEventInsert {
  eventId: string;
  eventType: string;
  occurredAt: string;
  payloadJson: string;
  signatureTs: number;
}

export interface UpsertSubscriptionFromWebhookInput {
  userId: string;
  planCode: string;
  status: string;
  occurredAt: string;
  paddleSubscriptionId: string;
  paddleCustomerId: string;
  paddlePriceId: string | null;
  paddleProductId: string | null;
  currentPeriodStartsAt: string | null;
  currentPeriodEndsAt: string | null;
  firstBilledAt: string | null;
  nextBilledAt: string | null;
  canceledAt: string | null;
  pausedAt: string | null;
  pastDueAt: string | null;
  scheduledChangeAction: string | null;
  scheduledChangeEffectiveAt: string | null;
  scheduledChangeResumeAt: string | null;
}

export interface BillingRepository {
  findUserById: (userId: string) => Promise<BillingUserRecord | null>;
  findUserByEmail: (email: string) => Promise<BillingUserRecord | null>;
  findUserByPaddleCustomerId: (paddleCustomerId: string) => Promise<BillingUserRecord | null>;
  setUserPaddleCustomerId: (userId: string, paddleCustomerId: string) => Promise<void>;
  getPriceIdForPlan: (planCode: string) => Promise<string | null>;
  insertWebhookEventIfNew: (input: BillingWebhookEventInsert) => Promise<{ shouldProcess: boolean; duplicate: boolean }>;
  markWebhookProcessed: (eventId: string) => Promise<void>;
  markWebhookFailed: (eventId: string, errorMessage: string) => Promise<void>;
  getSubscriptionByPaddleId: (paddleSubscriptionId: string) => Promise<BillingSubscriptionRecord | null>;
  listSubscriptionsByUserId: (userId: string) => Promise<BillingSubscriptionRecord[]>;
  upsertSubscriptionFromWebhook: (input: UpsertSubscriptionFromWebhookInput) => Promise<{ applied: boolean; subscriptionId: string }>;
  setPaidEntitlement: (userId: string, subscriptionId: string, enabled: boolean) => Promise<void>;
}

interface BillingUserRow {
  id: string;
  email: string;
  paddle_customer_id: string | null;
}

interface BillingSubscriptionRow {
  id: string;
  user_id: string;
  status: string;
  plan_code: string;
  provider: string;
  paddle_subscription_id: string | null;
  paddle_customer_id: string | null;
  paddle_price_id: string | null;
  paddle_product_id: string | null;
  current_period_starts_at: string | null;
  current_period_ends_at: string | null;
  first_billed_at: string | null;
  next_billed_at: string | null;
  canceled_at: string | null;
  paused_at: string | null;
  past_due_at: string | null;
  scheduled_change_action: string | null;
  scheduled_change_effective_at: string | null;
  scheduled_change_resume_at: string | null;
  last_event_time: string | null;
}

function toUser(row: BillingUserRow): BillingUserRecord {
  return {
    id: row.id,
    email: row.email,
    paddleCustomerId: row.paddle_customer_id,
  };
}

function toSubscription(row: BillingSubscriptionRow): BillingSubscriptionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    planCode: row.plan_code,
    provider: row.provider,
    paddleSubscriptionId: row.paddle_subscription_id,
    paddleCustomerId: row.paddle_customer_id,
    paddlePriceId: row.paddle_price_id,
    paddleProductId: row.paddle_product_id,
    currentPeriodStartsAt: row.current_period_starts_at,
    currentPeriodEndsAt: row.current_period_ends_at,
    firstBilledAt: row.first_billed_at,
    nextBilledAt: row.next_billed_at,
    canceledAt: row.canceled_at,
    pausedAt: row.paused_at,
    pastDueAt: row.past_due_at,
    scheduledChangeAction: row.scheduled_change_action,
    scheduledChangeEffectiveAt: row.scheduled_change_effective_at,
    scheduledChangeResumeAt: row.scheduled_change_resume_at,
    lastEventTime: row.last_event_time,
  };
}

export class D1BillingRepository implements BillingRepository {
  private readonly db: D1Database;
  private readonly configuredPriceIds: Record<string, string>;

  constructor(db: D1Database | undefined, configuredPriceIds: Record<string, string>) {
    if (!db) {
      throw new ApiError({
        code: 'DB_NOT_CONFIGURED',
        status: 500,
        message: 'D1 database binding is not configured',
      });
    }
    this.db = db;
    this.configuredPriceIds = configuredPriceIds;
  }

  async findUserById(userId: string): Promise<BillingUserRecord | null> {
    const row = await this.db.prepare('SELECT id, email, paddle_customer_id FROM users WHERE id = ?1').bind(userId).first<BillingUserRow>();
    return row ? toUser(row) : null;
  }

  async findUserByEmail(email: string): Promise<BillingUserRecord | null> {
    const row = await this.db.prepare('SELECT id, email, paddle_customer_id FROM users WHERE email = ?1').bind(email).first<BillingUserRow>();
    return row ? toUser(row) : null;
  }

  async findUserByPaddleCustomerId(paddleCustomerId: string): Promise<BillingUserRecord | null> {
    const row = await this.db.prepare('SELECT id, email, paddle_customer_id FROM users WHERE paddle_customer_id = ?1').bind(paddleCustomerId).first<BillingUserRow>();
    return row ? toUser(row) : null;
  }

  async setUserPaddleCustomerId(userId: string, paddleCustomerId: string): Promise<void> {
    await this.db
      .prepare("UPDATE users SET paddle_customer_id = ?1, updated_at = datetime('now') WHERE id = ?2")
      .bind(paddleCustomerId, userId)
      .run();
  }

  async getPriceIdForPlan(planCode: string): Promise<string | null> {
    return this.configuredPriceIds[planCode] ?? null;
  }

  async insertWebhookEventIfNew(input: BillingWebhookEventInsert): Promise<{ shouldProcess: boolean; duplicate: boolean }> {
    await this.db
      .prepare(`
        INSERT OR IGNORE INTO paddle_webhook_events (
          event_id, event_type, occurred_at, payload_json, signature_ts
        ) VALUES (?1, ?2, ?3, ?4, ?5)
      `)
      .bind(input.eventId, input.eventType, input.occurredAt, input.payloadJson, String(input.signatureTs))
      .run();

    const existing = await this.db
      .prepare('SELECT event_id, processed_at FROM paddle_webhook_events WHERE event_id = ?1')
      .bind(input.eventId)
      .first<{ event_id: string; processed_at: string | null }>();

    if (!existing) {
      throw new ApiError({
        code: 'BILLING_WEBHOOK_PERSISTENCE_ERROR',
        status: 500,
        message: 'Webhook event persistence failed',
      });
    }

    if (existing.processed_at) {
      return { shouldProcess: false, duplicate: true };
    }

    const claimToken = `__claim__${crypto.randomUUID()}`;
    const claim = await this.db
      .prepare(`
        UPDATE paddle_webhook_events
        SET event_type = ?1,
            occurred_at = ?2,
            payload_json = ?3,
            signature_ts = ?4,
            processing_error = ?5
        WHERE event_id = ?6
          AND processed_at IS NULL
          AND (processing_error IS NULL OR processing_error NOT LIKE '__claim__%')
      `)
      .bind(input.eventType, input.occurredAt, input.payloadJson, String(input.signatureTs), claimToken, input.eventId)
      .run();

    const claimMeta = claim as D1RunResult & { meta?: { changes?: number } };
    const claimed = Number(claimMeta.meta?.changes ?? 0) > 0;
    if (!claimed) {
      return { shouldProcess: false, duplicate: true };
    }

    return { shouldProcess: true, duplicate: false };
  }

  async markWebhookProcessed(eventId: string): Promise<void> {
    await this.db
      .prepare("UPDATE paddle_webhook_events SET processed_at = datetime('now'), processing_error = NULL WHERE event_id = ?1")
      .bind(eventId)
      .run();
  }

  async markWebhookFailed(eventId: string, errorMessage: string): Promise<void> {
    await this.db
      .prepare("UPDATE paddle_webhook_events SET processing_error = ?1 WHERE event_id = ?2")
      .bind(errorMessage.slice(0, 800), eventId)
      .run();
  }

  async getSubscriptionByPaddleId(paddleSubscriptionId: string): Promise<BillingSubscriptionRecord | null> {
    const row = await this.db
      .prepare(`
        SELECT id, user_id, status, plan_code, provider,
               paddle_subscription_id, paddle_customer_id,
               paddle_price_id, paddle_product_id,
               current_period_starts_at, current_period_ends_at,
               first_billed_at, next_billed_at,
               canceled_at, paused_at, past_due_at,
               scheduled_change_action, scheduled_change_effective_at, scheduled_change_resume_at,
               last_event_time
        FROM subscriptions
        WHERE paddle_subscription_id = ?1
      `)
      .bind(paddleSubscriptionId)
      .first<BillingSubscriptionRow>();

    return row ? toSubscription(row) : null;
  }

  async listSubscriptionsByUserId(userId: string): Promise<BillingSubscriptionRecord[]> {
    const rows = await this.db
      .prepare(`
        SELECT id, user_id, status, plan_code, provider,
               paddle_subscription_id, paddle_customer_id,
               paddle_price_id, paddle_product_id,
               current_period_starts_at, current_period_ends_at,
               first_billed_at, next_billed_at,
               canceled_at, paused_at, past_due_at,
               scheduled_change_action, scheduled_change_effective_at, scheduled_change_resume_at,
               last_event_time
        FROM subscriptions
        WHERE user_id = ?1 AND provider = 'paddle'
        ORDER BY datetime(last_event_time) DESC
      `)
      .bind(userId)
      .all<BillingSubscriptionRow>();

    return (rows.results ?? []).map(toSubscription);
  }

  async upsertSubscriptionFromWebhook(input: UpsertSubscriptionFromWebhookInput): Promise<{ applied: boolean; subscriptionId: string }> {
    const existing = await this.getSubscriptionByPaddleId(input.paddleSubscriptionId);

    if (existing?.lastEventTime && new Date(existing.lastEventTime).getTime() > new Date(input.occurredAt).getTime()) {
      return { applied: false, subscriptionId: existing.id };
    }

    if (existing) {
      await this.db
        .prepare(`
          UPDATE subscriptions
          SET user_id = ?1,
              status = ?2,
              plan_code = ?3,
              provider = 'paddle',
              paddle_customer_id = ?4,
              paddle_price_id = ?5,
              paddle_product_id = ?6,
              current_period_starts_at = ?7,
              current_period_ends_at = ?8,
              first_billed_at = ?9,
              next_billed_at = ?10,
              canceled_at = ?11,
              paused_at = ?12,
              past_due_at = ?13,
              scheduled_change_action = ?14,
              scheduled_change_effective_at = ?15,
              scheduled_change_resume_at = ?16,
              last_event_time = ?17,
              updated_at = datetime('now')
          WHERE id = ?18
        `)
        .bind(
          input.userId,
          input.status,
          input.planCode,
          input.paddleCustomerId,
          input.paddlePriceId,
          input.paddleProductId,
          input.currentPeriodStartsAt,
          input.currentPeriodEndsAt,
          input.firstBilledAt,
          input.nextBilledAt,
          input.canceledAt,
          input.pausedAt,
          input.pastDueAt,
          input.scheduledChangeAction,
          input.scheduledChangeEffectiveAt,
          input.scheduledChangeResumeAt,
          input.occurredAt,
          existing.id,
        )
        .run();

      return { applied: true, subscriptionId: existing.id };
    }

    const reusable = await this.db
      .prepare("SELECT id, last_event_time FROM subscriptions WHERE user_id = ?1 AND provider != 'paddle' ORDER BY created_at ASC LIMIT 1")
      .bind(input.userId)
      .first<{ id: string; last_event_time: string | null }>();

    const subscriptionId = reusable?.id ?? crypto.randomUUID();
    if (reusable) {
      if (reusable.last_event_time && new Date(reusable.last_event_time).getTime() > new Date(input.occurredAt).getTime()) {
        return { applied: false, subscriptionId };
      }

      await this.db
        .prepare(`
          UPDATE subscriptions
          SET status = ?1,
              plan_code = ?2,
              provider = 'paddle',
              paddle_subscription_id = ?3,
              paddle_customer_id = ?4,
              paddle_price_id = ?5,
              paddle_product_id = ?6,
              current_period_starts_at = ?7,
              current_period_ends_at = ?8,
              first_billed_at = ?9,
              next_billed_at = ?10,
              canceled_at = ?11,
              paused_at = ?12,
              past_due_at = ?13,
              scheduled_change_action = ?14,
              scheduled_change_effective_at = ?15,
              scheduled_change_resume_at = ?16,
              last_event_time = ?17,
              updated_at = datetime('now')
          WHERE id = ?18
        `)
        .bind(
          input.status,
          input.planCode,
          input.paddleSubscriptionId,
          input.paddleCustomerId,
          input.paddlePriceId,
          input.paddleProductId,
          input.currentPeriodStartsAt,
          input.currentPeriodEndsAt,
          input.firstBilledAt,
          input.nextBilledAt,
          input.canceledAt,
          input.pausedAt,
          input.pastDueAt,
          input.scheduledChangeAction,
          input.scheduledChangeEffectiveAt,
          input.scheduledChangeResumeAt,
          input.occurredAt,
          reusable.id,
        )
        .run();

      return { applied: true, subscriptionId: reusable.id };
    }

    await this.db
      .prepare(`
        INSERT INTO subscriptions (
          id, user_id, status, plan_code, provider,
          paddle_subscription_id, paddle_customer_id,
          paddle_price_id, paddle_product_id,
          current_period_starts_at, current_period_ends_at,
          first_billed_at, next_billed_at,
          canceled_at, paused_at, past_due_at,
          scheduled_change_action, scheduled_change_effective_at, scheduled_change_resume_at,
          last_event_time
        ) VALUES (?1, ?2, ?3, ?4, 'paddle', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
      `)
      .bind(
        subscriptionId,
        input.userId,
        input.status,
        input.planCode,
        input.paddleSubscriptionId,
        input.paddleCustomerId,
        input.paddlePriceId,
        input.paddleProductId,
        input.currentPeriodStartsAt,
        input.currentPeriodEndsAt,
        input.firstBilledAt,
        input.nextBilledAt,
        input.canceledAt,
        input.pausedAt,
        input.pastDueAt,
        input.scheduledChangeAction,
        input.scheduledChangeEffectiveAt,
        input.scheduledChangeResumeAt,
        input.occurredAt,
      )
      .run();

    return { applied: true, subscriptionId };
  }

  async setPaidEntitlement(userId: string, subscriptionId: string, enabled: boolean): Promise<void> {
    const existing = await this.db
      .prepare('SELECT id FROM entitlements WHERE user_id = ?1 AND entitlement_key = ?2')
      .bind(userId, 'billing.paid')
      .first<{ id: string }>();

    if (existing) {
      await this.db
        .prepare("UPDATE entitlements SET status = ?1, subscription_id = ?2, updated_at = datetime('now') WHERE id = ?3")
        .bind(enabled ? 'active' : 'inactive', subscriptionId, existing.id)
        .run();
      return;
    }

    await this.db
      .prepare(`
        INSERT INTO entitlements (id, user_id, subscription_id, entitlement_key, status)
        VALUES (?1, ?2, ?3, ?4, ?5)
      `)
      .bind(crypto.randomUUID(), userId, subscriptionId, 'billing.paid', enabled ? 'active' : 'inactive')
      .run();
  }
}
