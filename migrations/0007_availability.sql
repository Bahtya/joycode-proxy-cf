-- 0007_availability.sql
-- Per-minute upstream availability samples for the dashboard availability card.
-- The keepalive cron writes one row per minute (ok = chat probe returned
-- choices; chat_ms/ping_ms latencies); rows older than 60 minutes are pruned on
-- each insert. The card renders the last 60 frames (green/red) + availability
-- rate = green/60. Idempotent.
CREATE TABLE IF NOT EXISTS availability_samples (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL DEFAULT (datetime('now')),  -- UTC
  ok      INTEGER NOT NULL DEFAULT 0,   -- 1 = chat returned choices, 0 = empty/error
  chat_ms INTEGER NOT NULL DEFAULT 0,
  ping_ms INTEGER NOT NULL DEFAULT 0,
  error   TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_avail_ts ON availability_samples(ts DESC);
