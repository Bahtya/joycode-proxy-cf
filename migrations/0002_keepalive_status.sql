-- keepalive status (replaces the Go in-memory status map read by the dashboard).
-- Written by the companion Cron Worker; read by the dashboard API.

CREATE TABLE IF NOT EXISTS keepalive_status (
  user_id        TEXT PRIMARY KEY,
  last_checked   TEXT NOT NULL DEFAULT '',
  last_refreshed TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT '',   -- 'ok' | 'refreshed' | 'stale' | 'error'
  message        TEXT NOT NULL DEFAULT '',
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
