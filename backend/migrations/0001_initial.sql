-- BusinessFlow backend foundation migration (Phase 1)
-- Minimal schema only: system metadata used for readiness checks and migration tracking.

CREATE TABLE IF NOT EXISTS backend_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

INSERT OR IGNORE INTO backend_meta (key, value) VALUES ('schema_version', '1');
