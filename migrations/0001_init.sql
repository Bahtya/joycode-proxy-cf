-- JoyCodeProxy D1 schema (ported from pkg/store/store.go:239-281).
-- Differences from the Go SQLite schema:
--   * no WAL pragma (D1 manages storage)
--   * timestamps are UTC (datetime('now')) to avoid cross-region TZ drift
--   * the Go ALTER-added columns (error_message, input_tokens, output_tokens,
--     display_order) are folded into the canonical CREATE for this fresh DB.

CREATE TABLE IF NOT EXISTS accounts (
  user_id                 TEXT PRIMARY KEY,
  nickname                TEXT NOT NULL DEFAULT '',
  remark                  TEXT NOT NULL DEFAULT '',
  api_token               TEXT NOT NULL DEFAULT '',
  pt_key                  TEXT NOT NULL,                       -- AES-256-GCM hex(nonce[12]||ct)
  is_default              INTEGER NOT NULL DEFAULT 0,
  default_model           TEXT NOT NULL DEFAULT '',
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
  credential_refreshed_at TEXT NOT NULL DEFAULT '',
  credential_valid        INTEGER NOT NULL DEFAULT -1,         -- -1 unknown, 0 invalid, 1 valid
  display_order           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS request_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key       TEXT,
  model         TEXT,
  endpoint      TEXT,
  stream        INTEGER NOT NULL DEFAULT 0,
  status_code   INTEGER,
  latency_ms    INTEGER,
  error_message TEXT NOT NULL DEFAULT '',
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_request_logs_api_key ON request_logs(api_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_created  ON request_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_accounts_token        ON accounts(api_token);
CREATE INDEX IF NOT EXISTS idx_accounts_default      ON accounts(is_default);
CREATE INDEX IF NOT EXISTS idx_accounts_order        ON accounts(display_order);
