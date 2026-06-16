// Dashboard aggregation queries over D1.
// Ports the read-only stats / logs / error methods from pkg/store/store.go
// (GetStats, GetAllTimeTotals, GetHourlyStats, GetRecentLogs, GetRecentErrors,
//  GetAccountStats, GetAccountLogs, FillAccountStats).
//
// IMPORTANT: the Go SQLite schema stored timestamps in localtime and filtered with
// `date(created_at, 'localtime') = date('now', 'localtime')`. The D1 port stores
// UTC timestamps (see migrations/0001_init.sql: `DEFAULT (datetime('now'))`), so
// every "today" / "-24 hours" filter is rewritten against UTC. This keeps the
// dashboard consistent with what the proxy actually writes here.

import type { RequestLogRow } from '../types';

export interface ModelCount {
  model: string;
  count: number;
}

export interface ClientCount {
  client: string;
  count: number;
}

export interface AccountCount {
  user_id: string;
  nickname: string;
  remark: string;
  count: number;
}

export interface EndpointCount {
  endpoint: string;
  count: number;
}

export interface AllTimeTotals {
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  error_count: number;
}

export interface HourlyData {
  hour: string;
  count: number;
  input_tokens: number;
  output_tokens: number;
  errors: number;
}

export interface GlobalStats {
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  accounts_count: number;
  avg_latency_ms: number;
  error_count: number;
  stream_count: number;
  success_count: number;
  by_model: ModelCount[];
  by_account: AccountCount[];
  by_client: ClientCount[];
  all_time: AllTimeTotals;
  hourly: HourlyData[];
}

export interface AccountStats {
  user_id: string;
  nickname: string;
  remark: string;
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  success_count: number;
  stream_count: number;
  by_model: ModelCount[];
  by_endpoint: EndpointCount[];
  avg_latency_ms: number;
  error_count: number;
  all_time: AllTimeTotals;
  hourly: HourlyData[];
}

/** A request-log row shaped the way the React frontend expects (snake_case, boolean stream). */
export interface DashboardLog {
  id: number;
  user_id: string;
  model: string;
  endpoint: string;
  stream: boolean;
  status_code: number;
  latency_ms: number;
  error_message: string;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
}

// "Today" filter in UTC (D1 stores datetime('now') = UTC). Sargable range form so
// idx_request_logs_created(created_at) can be used (the date()= wrapper was not). (P1)
const TODAY = "created_at >= datetime('now', 'start of day')";
// "Last 24 hours" window in UTC.
const LAST_24H = "created_at >= datetime('now', '-24 hours')";

/** Map a stored RequestLogRow (stream as 0/1) to the frontend's boolean-stream shape. */
function toDashboardLog(r: RequestLogRow): DashboardLog {
  return {
    id: r.id ?? 0,
    user_id: r.api_key ?? '',
    model: r.model ?? '',
    endpoint: r.endpoint ?? '',
    stream: r.stream === 1,
    status_code: r.status_code ?? 0,
    latency_ms: r.latency_ms ?? 0,
    error_message: r.error_message ?? '',
    input_tokens: r.input_tokens ?? 0,
    output_tokens: r.output_tokens ?? 0,
    created_at: r.created_at ?? '',
  };
}

const LOG_COLS =
  'id, api_key, model, endpoint, stream, status_code, latency_ms, COALESCE(error_message, \'\') AS error_message, COALESCE(input_tokens, 0) AS input_tokens, COALESCE(output_tokens, 0) AS output_tokens, created_at';

async function safeFirst<T>(p: Promise<{ results?: T[] } | T | null>): Promise<T | null> {
  try {
    return (await p) as T;
  } catch {
    return null;
  }
}

/**
 * Global dashboard stats. Mirrors store.GetStats + GetAllTimeTotals + GetHourlyStats.
 * Optionally scoped to a single account via opts.userId (used by the account detail view).
 */
export async function getStats(
  db: D1Database,
  opts: { userId?: string; days?: number } = {}
): Promise<GlobalStats> {
  const scoped = !!opts.userId;
  const scope = scoped ? `AND api_key = ?` : '';
  const binds: string[] = scoped ? [opts.userId as string] : [];
  const todayFilter = `WHERE ${TODAY} ${scope}`;
  const bind = <T>(stmt: D1PreparedStatement): D1PreparedStatement => (binds.length ? stmt.bind(...binds) : stmt);

  // by_account is global-only and runs its 2 sub-queries as one unit.
  const byAccount = async (): Promise<AccountCount[]> => {
    if (scoped) return [];
    const { results: accts } = await db
      .prepare('SELECT user_id, nickname, remark FROM accounts ORDER BY display_order, created_at')
      .all<{ user_id: string; nickname: string; remark: string }>();
    const validKeys = new Set(accts.map((a) => a.user_id));
    const nameMap = new Map(accts.map((a) => [a.user_id, a]));
    const { results: raw } = await db
      .prepare(`SELECT api_key AS user_id, COUNT(*) AS count FROM request_logs WHERE ${TODAY} GROUP BY api_key ORDER BY count DESC`)
      .all<{ user_id: string; count: number }>();
    const out: AccountCount[] = [];
    let other = 0;
    for (const r of raw) {
      if (validKeys.has(r.user_id)) {
        const meta = nameMap.get(r.user_id);
        out.push({ user_id: r.user_id, nickname: meta?.nickname ?? '', remark: meta?.remark ?? '', count: r.count });
      } else {
        other += r.count;
      }
    }
    if (other > 0) out.push({ user_id: '其他', nickname: '其他', remark: '', count: other });
    return out;
  };

  // Collapse the 7 sequential scalar scans into ONE conditional-aggregation query and
  // run the independent queries in parallel. (P1)
  const [agg, accountsCountRow, byModelRes, byClientRes, by_account, all_time, hourly] = await Promise.all([
    bind(
      db.prepare(
        `SELECT
           COUNT(*) AS total_requests,
           COALESCE(AVG(latency_ms), 0) AS avg_latency,
           SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS error_count,
           SUM(CASE WHEN stream = 1 THEN 1 ELSE 0 END) AS stream_count,
           SUM(CASE WHEN status_code < 400 THEN 1 ELSE 0 END) AS success_count,
           COALESCE(SUM(input_tokens), 0) AS total_input,
           COALESCE(SUM(output_tokens), 0) AS total_output
         FROM request_logs ${todayFilter}`
      )
    ).first<{
      total_requests: number; avg_latency: number; error_count: number;
      stream_count: number; success_count: number; total_input: number; total_output: number;
    }>(),
    db.prepare('SELECT COUNT(*) AS n FROM accounts').first<{ n: number }>(),
    bind(
      db.prepare(
        `SELECT model AS model, COUNT(*) AS count FROM request_logs ${todayFilter} AND model != '' GROUP BY model ORDER BY count DESC`
      )
    ).all<ModelCount>(),
    bind(
      db.prepare(
        `SELECT client AS client, COUNT(*) AS count FROM request_logs ${todayFilter} AND client != '' GROUP BY client ORDER BY count DESC`
      )
    ).all<ClientCount>(),
    byAccount(),
    getAllTimeTotals(db, opts.userId),
    getHourlyStats(db, opts.userId),
  ]);

  return {
    total_requests: agg?.total_requests ?? 0,
    total_input_tokens: agg?.total_input ?? 0,
    total_output_tokens: agg?.total_output ?? 0,
    accounts_count: accountsCountRow?.n ?? 0,
    avg_latency_ms: agg?.avg_latency ?? 0,
    error_count: agg?.error_count ?? 0,
    stream_count: agg?.stream_count ?? 0,
    success_count: agg?.success_count ?? 0,
    by_model: byModelRes.results ?? [],
    by_client: byClientRes.results ?? [],
    by_account,
    all_time,
    hourly,
  };
}

/** All-time totals (store.GetAllTimeTotals), optionally scoped to one account.
 *
 *  Computed as rolled-up history (stats_daily) + live-window raw (request_logs).
 *  The two are disjoint — rollupLogs deletes a day's raw rows after aggregating
 *  them into stats_daily — so summing both never double-counts, and reading the
 *  rollup avoids scanning the full raw table (O(days×accounts×models) vs O(rows)).
 *  Used by the global dashboard all_time AND per-account all_time. */
export async function getAllTimeTotals(db: D1Database, userId?: string): Promise<AllTimeTotals> {
  const scope = userId ? `WHERE api_key = ?` : '';
  const bind = (s: D1PreparedStatement): D1PreparedStatement => (userId ? s.bind(userId) : s);
  type Row = { total_requests: number; total_input: number; total_output: number; error_count: number };
  const [rolled, recent] = await Promise.all([
    bind(
      db.prepare(
        `SELECT
           COALESCE(SUM(request_count), 0) AS total_requests,
           COALESCE(SUM(input_tokens), 0) AS total_input,
           COALESCE(SUM(output_tokens), 0) AS total_output,
           COALESCE(SUM(error_count), 0) AS error_count
         FROM stats_daily ${scope}`
      )
    ).first<Row>(),
    bind(
      db.prepare(
        `SELECT
           COUNT(*) AS total_requests,
           COALESCE(SUM(input_tokens), 0) AS total_input,
           COALESCE(SUM(output_tokens), 0) AS total_output,
           SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS error_count
         FROM request_logs ${scope}`
      )
    ).first<Row>(),
  ]);
  return {
    total_requests: (rolled?.total_requests ?? 0) + (recent?.total_requests ?? 0),
    total_input_tokens: (rolled?.total_input ?? 0) + (recent?.total_input ?? 0),
    total_output_tokens: (rolled?.total_output ?? 0) + (recent?.total_output ?? 0),
    error_count: (rolled?.error_count ?? 0) + (recent?.error_count ?? 0),
  };
}

/** Hourly bucket counts for the last 24h (store.GetHourlyStats), optionally scoped. */
export async function getHourlyStats(db: D1Database, userId?: string): Promise<HourlyData[]> {
  const scope = userId ? `AND api_key = ?` : '';
  const stmt = db.prepare(
    `SELECT strftime('%m-%d %H', created_at) AS hour,
            COUNT(*) AS count,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors
       FROM request_logs
       WHERE created_at >= datetime('now', '-24 hours') ${scope}
       GROUP BY hour
       ORDER BY hour`
  );
  const res = userId ? await stmt.bind(userId).all<HourlyData>() : await stmt.all<HourlyData>();
  return res.results ?? [];
}

export interface RecentLogsOpts {
  userId?: string;
  limit?: number;
  offset?: number;
  endpoint?: string;
  status?: 'error' | 'success' | 'all';
}

/** Recent logs with filters + LIMIT/OFFSET (frontend /api/accounts/:id/logs). */
export async function getRecentLogs(db: D1Database, opts: RecentLogsOpts = {}): Promise<DashboardLog[]> {
  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (opts.userId) {
    where.push('api_key = ?');
    binds.push(opts.userId);
  }
  if (opts.endpoint) {
    where.push('endpoint = ?');
    binds.push(opts.endpoint);
  }
  if (opts.status === 'error') where.push('status_code >= 400');
  else if (opts.status === 'success') where.push('status_code < 400');

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 1000) : 100;
  const offset = opts.offset && opts.offset > 0 ? opts.offset : 0;

  const { results } = await db
    .prepare(`SELECT ${LOG_COLS} FROM request_logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset)
    .all<RequestLogRow>();
  return (results ?? []).map(toDashboardLog);
}

/** Account detail stats (store.GetAccountStats). */
export async function getAccountStats(db: D1Database, userId: string): Promise<AccountStats> {
  const tf = LAST_24H;
  const scalar = async <T>(sql: string): Promise<T | null> => safeFirst<T>(db.prepare(sql).bind(userId).first<T>());

  const totalRequests = (await scalar<{ n: number }>(`SELECT COUNT(*) AS n FROM request_logs WHERE api_key = ? AND ${tf}`))?.n ?? 0;
  const avgLatency =
    (await scalar<{ a: number }>(`SELECT COALESCE(AVG(latency_ms), 0) AS a FROM request_logs WHERE api_key = ? AND ${tf}`))?.a ?? 0;
  const streamCount =
    (await scalar<{ n: number }>(`SELECT COUNT(*) AS n FROM request_logs WHERE api_key = ? AND stream = 1 AND ${tf}`))?.n ?? 0;
  const errorCount =
    (await scalar<{ n: number }>(`SELECT COUNT(*) AS n FROM request_logs WHERE api_key = ? AND status_code >= 400 AND ${tf}`))?.n ??
    0;
  const successCount =
    (await scalar<{ n: number }>(`SELECT COUNT(*) AS n FROM request_logs WHERE api_key = ? AND status_code < 400 AND ${tf}`))?.n ??
    0;
  const totalInput =
    (await scalar<{ s: number }>(`SELECT COALESCE(SUM(input_tokens), 0) AS s FROM request_logs WHERE api_key = ? AND ${tf}`))?.s ??
    0;
  const totalOutput =
    (await scalar<{ s: number }>(`SELECT COALESCE(SUM(output_tokens), 0) AS s FROM request_logs WHERE api_key = ? AND ${tf}`))?.s ??
    0;

  const { results: byModelRaw } = await db
    .prepare(
      `SELECT model AS model, COUNT(*) AS count FROM request_logs WHERE api_key = ? AND ${tf} GROUP BY model ORDER BY count DESC`
    )
    .bind(userId)
    .all<ModelCount>();
  const { results: byEndpointRaw } = await db
    .prepare(
      `SELECT endpoint AS endpoint, COUNT(*) AS count FROM request_logs WHERE api_key = ? AND ${tf} GROUP BY endpoint ORDER BY count DESC`
    )
    .bind(userId)
    .all<EndpointCount>();

  const meta = await db
    .prepare('SELECT user_id, nickname, remark FROM accounts WHERE user_id = ?')
    .bind(userId)
    .first<{ user_id: string; nickname: string; remark: string }>();

  const all_time = await getAllTimeTotals(db, userId);
  const hourly = await getHourlyStats(db, userId);

  return {
    user_id: meta?.user_id ?? userId,
    nickname: meta?.nickname ?? '',
    remark: meta?.remark ?? '',
    total_requests: totalRequests,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    success_count: successCount,
    stream_count: streamCount,
    by_model: byModelRaw ?? [],
    by_endpoint: byEndpointRaw ?? [],
    avg_latency_ms: avgLatency,
    error_count: errorCount,
    all_time,
    hourly,
  };
}

export interface ErrorStats {
  total: number;
  recent: DashboardLog[];
}

/** Aggregated error info for /api/errors: recent error rows + a total (store.GetRecentErrors). */
export async function getErrorStats(db: D1Database, limit = 50): Promise<ErrorStats> {
  const clamped = limit > 0 && limit <= 200 ? limit : 50;
  const { results } = await db
    .prepare(`SELECT ${LOG_COLS} FROM request_logs WHERE status_code >= 400 ORDER BY id DESC LIMIT ?`)
    .bind(clamped)
    .all<RequestLogRow>();
  const recent = (results ?? []).map(toDashboardLog);
  const total = (await db.prepare('SELECT COUNT(*) AS n FROM request_logs WHERE status_code >= 400').first<{ n: number }>())?.n ?? 0;
  return { total, recent };
}
