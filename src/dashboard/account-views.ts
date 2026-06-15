// Shared helpers for per-account sub-action routes (functions/api/accounts/[apiKey]/*).
// Kept out of the route files so each route is a thin PagesFunction.
import type { Env } from '../types';
import { createJoyClient } from '../joycode/client';

export function clientFor(env: Env, account: { ptKey: string; userId: string }) {
  return createJoyClient({
    ptKey: account.ptKey,
    userId: account.userId,
    baseURL: env.JOYCODE_BASE_URL,
    saasBaseURL: env.JOYCODE_SAAS_BASE_URL,
    clientVersion: env.JOYCODE_CLIENT_VERSION,
    timeoutSec: parseInt(env.DEFAULT_TIMEOUT || '30', 10),
  });
}

/** GET /api/accounts/<userId>/stats — mirrors GetAccountStats (store.go:1154-1221). */
export async function accountStatsResponse(env: Env, userId: string): Promise<Response> {
  const db = env.DB;
  const tf = "created_at >= datetime('now', '-24 hours')";

  const scalar = await db
    .prepare(
      `SELECT
         COUNT(*) AS total_requests,
         COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
         SUM(CASE WHEN stream = 1 THEN 1 ELSE 0 END) AS stream_count,
         SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS error_count,
         SUM(CASE WHEN status_code < 400 THEN 1 ELSE 0 END) AS success_count,
         COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0) AS total_output_tokens
       FROM request_logs WHERE api_key = ? AND ${tf}`
    )
    .bind(userId)
    .first<Record<string, number>>();

  const byModel = await db
    .prepare(
      `SELECT model, COUNT(*) AS count FROM request_logs
       WHERE api_key = ? AND ${tf} GROUP BY model ORDER BY count DESC`
    )
    .bind(userId)
    .all<{ model: string; count: number }>();

  const byEndpoint = await db
    .prepare(
      `SELECT endpoint, COUNT(*) AS count FROM request_logs
       WHERE api_key = ? AND ${tf} GROUP BY endpoint ORDER BY count DESC`
    )
    .bind(userId)
    .all<{ endpoint: string; count: number }>();

  const allTime = await db
    .prepare(
      `SELECT
         COUNT(*) AS total_requests,
         COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
         SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS error_count
       FROM request_logs WHERE api_key = ?`
    )
    .bind(userId)
    .first<Record<string, number>>();

  const hourly = await db
    .prepare(
      `SELECT strftime('%m-%d %H', created_at) AS hour,
              COUNT(*) AS count,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors
       FROM request_logs WHERE api_key = ? AND ${tf}
       GROUP BY hour ORDER BY hour`
    )
    .bind(userId)
    .all<{
      hour: string;
      count: number;
      input_tokens: number;
      output_tokens: number;
      errors: number;
    }>();

  return Response.json({
    user_id: userId,
    nickname: '',
    remark: '',
    total_requests: scalar?.total_requests ?? 0,
    total_input_tokens: scalar?.total_input_tokens ?? 0,
    total_output_tokens: scalar?.total_output_tokens ?? 0,
    success_count: scalar?.success_count ?? 0,
    stream_count: scalar?.stream_count ?? 0,
    by_model: byModel.results ?? [],
    by_endpoint: byEndpoint.results ?? [],
    avg_latency_ms: scalar?.avg_latency_ms ?? 0,
    error_count: scalar?.error_count ?? 0,
    all_time: {
      total_requests: allTime?.total_requests ?? 0,
      total_input_tokens: allTime?.total_input_tokens ?? 0,
      total_output_tokens: allTime?.total_output_tokens ?? 0,
      error_count: allTime?.error_count ?? 0,
    },
    hourly: hourly.results ?? [],
  });
}

/** GET /api/accounts/<userId>/logs — mirrors GetAccountLogs (store.go:1223). */
export async function accountLogsResponse(env: Env, url: URL, userId: string): Promise<Response> {
  let limit = 200;
  const l = url.searchParams.get('limit');
  if (l) {
    const n = parseInt(l, 10);
    if (Number.isFinite(n) && n > 0 && n <= 1000) limit = n;
  }
  const { results } = await env.DB
    .prepare(
      `SELECT id, api_key AS user_id, model, endpoint, stream, status_code, latency_ms,
              COALESCE(error_message, '') AS error_message,
              COALESCE(input_tokens, 0) AS input_tokens,
              COALESCE(output_tokens, 0) AS output_tokens, created_at
       FROM request_logs WHERE api_key = ? ORDER BY id DESC LIMIT ?`
    )
    .bind(userId, limit)
    .all<Record<string, unknown>>();
  const logs = (results ?? []).map((r) => ({ ...r, stream: r.stream === 1 || r.stream === true }));
  return Response.json({ logs, total: logs.length });
}

/** Resolve the userId path param (Pages passes it as params.apiKey). */
export function userIdParam(params: Record<string, unknown>): string {
  const v = params.apiKey;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return (v[0] as string) ?? '';
  return '';
}
