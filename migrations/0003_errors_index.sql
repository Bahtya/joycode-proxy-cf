-- 0003: covering index for error-status queries (status_code >= 400) used by
-- getErrorStats and the recent-errors list. Lets the unbounded error COUNT(*) and
-- the "recent errors" scan seek the index instead of doing a full table scan. (P5)
CREATE INDEX IF NOT EXISTS idx_request_logs_status ON request_logs(status_code, id DESC);
