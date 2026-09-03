-- Phase 3 Paddle billing foundation (sandbox mode)

ALTER TABLE users ADD COLUMN paddle_customer_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_paddle_customer_id ON users(paddle_customer_id);

ALTER TABLE subscriptions ADD COLUMN provider TEXT NOT NULL DEFAULT 'internal';
ALTER TABLE subscriptions ADD COLUMN paddle_subscription_id TEXT;
ALTER TABLE subscriptions ADD COLUMN paddle_customer_id TEXT;
ALTER TABLE subscriptions ADD COLUMN paddle_price_id TEXT;
ALTER TABLE subscriptions ADD COLUMN paddle_product_id TEXT;
ALTER TABLE subscriptions ADD COLUMN current_period_starts_at TEXT;
ALTER TABLE subscriptions ADD COLUMN current_period_ends_at TEXT;
ALTER TABLE subscriptions ADD COLUMN canceled_at TEXT;
ALTER TABLE subscriptions ADD COLUMN paused_at TEXT;
ALTER TABLE subscriptions ADD COLUMN past_due_at TEXT;
ALTER TABLE subscriptions ADD COLUMN last_event_time TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_paddle_subscription_id ON subscriptions(paddle_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_paddle_customer_id ON subscriptions(paddle_customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_provider ON subscriptions(provider);
CREATE INDEX IF NOT EXISTS idx_subscriptions_last_event_time ON subscriptions(last_event_time);

CREATE TABLE IF NOT EXISTS paddle_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  signature_ts TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  processing_error TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_paddle_webhook_events_received_at ON paddle_webhook_events(received_at);
CREATE INDEX IF NOT EXISTS idx_paddle_webhook_events_processed_at ON paddle_webhook_events(processed_at);
