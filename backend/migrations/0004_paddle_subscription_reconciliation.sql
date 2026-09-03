-- Paddle webhook reconciliation expansion (sandbox)
-- Adds fields required to mirror scheduled changes and billing dates.

ALTER TABLE subscriptions ADD COLUMN first_billed_at TEXT;
ALTER TABLE subscriptions ADD COLUMN next_billed_at TEXT;
ALTER TABLE subscriptions ADD COLUMN scheduled_change_action TEXT;
ALTER TABLE subscriptions ADD COLUMN scheduled_change_effective_at TEXT;
ALTER TABLE subscriptions ADD COLUMN scheduled_change_resume_at TEXT;

CREATE INDEX IF NOT EXISTS idx_subscriptions_scheduled_change_effective_at ON subscriptions(scheduled_change_effective_at);
CREATE INDEX IF NOT EXISTS idx_subscriptions_next_billed_at ON subscriptions(next_billed_at);
