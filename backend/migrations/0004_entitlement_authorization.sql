-- Phase 4 entitlement and authorization foundation

ALTER TABLE users ADD COLUMN access_revoked_at TEXT;
ALTER TABLE users ADD COLUMN access_revocation_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_users_access_revoked_at ON users(access_revoked_at);
