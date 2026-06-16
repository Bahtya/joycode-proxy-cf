-- 0005_client.sql
-- Per-request client dimension (derived from the inbound User-Agent) for the
-- dashboard's client-distribution pie chart. Existing rows backfill to ''.
--
-- SQLite has no ALTER TABLE ... ADD COLUMN IF NOT EXISTS, so this is a one-shot
-- migration: re-running errors with "duplicate column name" (harmless). The
-- other migrations use CREATE ... IF NOT EXISTS; this one is applied once.
ALTER TABLE request_logs ADD COLUMN client TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_request_logs_client ON request_logs(client, created_at DESC);
