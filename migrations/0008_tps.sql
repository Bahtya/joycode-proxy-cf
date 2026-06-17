-- Tokens-per-second for stream requests. Captured at log time as
-- completion_tokens / ((lastChunkMs - firstChunkMs) / 1000); 0 for non-stream /
-- error / no-usage rows. Averaged (non-zero only) for the dashboard card.
-- One-shot ALTER, like 0005_client.sql / 0006_user_agent.sql.
ALTER TABLE request_logs ADD COLUMN tps REAL NOT NULL DEFAULT 0;
