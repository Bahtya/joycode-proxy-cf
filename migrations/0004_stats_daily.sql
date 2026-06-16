-- 0004_stats_daily.sql
-- Daily rollup of request stats (day × account × model) for fast all-time
-- dashboard queries. Raw request_logs are kept for a live window (~7 days) for
-- fine-grained views (hourly chart, recent logs, today); older days are
-- aggregated into stats_daily here and the raw rows deleted (see Store.rollupLogs).
-- all-time totals then read O(days×accounts×models) rows from stats_daily instead
-- of scanning the full raw table. Idempotent.
CREATE TABLE IF NOT EXISTS stats_daily (
  day            TEXT NOT NULL,        -- 'YYYY-MM-DD' (UTC)
  api_key        TEXT NOT NULL,
  model          TEXT NOT NULL,
  request_count  INTEGER NOT NULL DEFAULT 0,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  error_count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, api_key, model)
);

CREATE INDEX IF NOT EXISTS idx_stats_daily_api_key ON stats_daily(api_key, day DESC);
