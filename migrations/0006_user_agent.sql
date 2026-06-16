-- 0006_user_agent.sql
-- Raw inbound User-Agent per request, for client-feature collection / detection
-- calibration. Stored truncated to 256 chars at the application layer. Existing
-- rows backfill to ''. One-shot ALTER (SQLite has no ADD COLUMN IF NOT EXISTS);
-- re-run errors "duplicate column" harmlessly.
ALTER TABLE request_logs ADD COLUMN user_agent TEXT NOT NULL DEFAULT '';
