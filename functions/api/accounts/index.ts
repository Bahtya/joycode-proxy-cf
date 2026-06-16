// /api/accounts — list, add, reorder.
// Ports pkg/dashboard/handler.go: handleAccounts (484) → listAccounts (501) / addAccount (528),
// and the reorderAccounts (1050) sub-action that the Go router serves from PUT /api/accounts/reorder.
//
// JWT-gated by functions/api/_middleware.ts (auth is done before we run).
import type { Env, Account } from '../../../src/types';
import { createStore } from '../../../src/store/d1';
import { getAllTimeTotals } from '../../../src/store/dashboard';
import { createJoyClient } from '../../../src/joycode/client';
import { readJson, jsonError, notFound } from '../../../src/util/http';

/** The dashboard AccountInfo shape the frontend expects (mirrors store.go:48-66). */
interface AccountInfo {
  user_id: string;
  nickname: string;
  remark: string;
  api_token: string;
  is_default: boolean;
  default_model: string;
  created_at: string;
  display_order: number;
  active_sessions: number;
  total_requests: number;
  today_requests: number;
  total_tokens: number;
  today_tokens: number;
  credential_valid: number; // -1 unknown, 0 invalid, 1 valid
  credential_checked_at?: string;
  credential_refreshed_at?: string;
  credential_error?: string;
}

/**
 * Map a decrypted Account to the dashboard AccountInfo shape, filling the
 * request/token stats from D1 (mirrors Go FillAccountStats, store.go:628-684).
 *
 * Done inline here rather than in src/store so we don't touch the foundation.
 */
async function toAccountInfo(db: D1Database, a: Account): Promise<AccountInfo> {
  const key = a.userId;
  // all-time = rolled-up stats_daily + live-window raw (disjoint; see
  // getAllTimeTotals) — replaces an unscoped request_logs scan that would
  // under-count once old raw days are rolled up + deleted. today stays raw.
  const [allTotals, todayRow] = await Promise.all([
    getAllTimeTotals(db, key),
    db
      .prepare(
        `SELECT COUNT(*) AS req, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
         FROM request_logs
         WHERE api_key = ? AND created_at >= datetime('now', 'start of day')`
      )
      .bind(key)
      .first<{ req: number; tokens: number }>(),
  ]);

  return {
    user_id: a.userId,
    nickname: a.nickname,
    remark: a.remark,
    api_token: a.apiToken,
    is_default: a.isDefault,
    default_model: a.defaultModel,
    created_at: a.createdAt,
    display_order: a.displayOrder,
    active_sessions: 0, // no in-memory session tracker on the edge (proxy.GetActiveSessions is local-only)
    total_requests: allTotals.total_requests,
    today_requests: todayRow?.req ?? 0,
    total_tokens: allTotals.total_input_tokens + allTotals.total_output_tokens,
    today_tokens: todayRow?.tokens ?? 0,
    credential_valid: a.credentialValid,
    credential_checked_at: a.credentialRefreshedAt,
    credential_refreshed_at: a.credentialRefreshedAt,
    credential_error: '',
  };
}

/** Resolve the JoyCode user_id + nickname from a pt_key via the upstream userInfo API.
 *  Mirrors validateAndSavePtKey (handler.go:773-821). */
async function resolveFromPtKey(
  env: Env,
  ptKey: string
): Promise<{ userId: string; nickname: string }> {
  const client = createJoyClient({
    ptKey,
    userId: '',
    baseURL: env.JOYCODE_BASE_URL,
    clientVersion: env.JOYCODE_CLIENT_VERSION,
  });
  const info = await client.userInfo(); // throws on non-200
  const code = info?.code;
  if (typeof code !== 'number' || code !== 0) {
    const msg = (info && info.msg) || 'unknown error';
    throw new Error(`userInfo API error (code=${code}): ${msg}`);
  }
  const data = (info && (info.data as Record<string, unknown> | undefined)) || undefined;
  let userId = '';
  let nickname = '';
  if (data) {
    const id = data.userId;
    const name = data.realName;
    if (typeof id === 'string' && id !== '') userId = id;
    if (typeof name === 'string' && name !== '') nickname = name;
  }
  if (!userId) throw new Error('无法获取用户ID，请重新授权');
  if (!nickname) nickname = userId;
  return { userId, nickname };
}

// --- GET /api/accounts ---
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  const accounts = await store.listAccounts();
  const infos = await Promise.all(accounts.map((a) => toAccountInfo(env.DB, a)));
  return Response.json({ accounts: infos });
};

// --- POST /api/accounts ---
// Dispatches on body shape: { action: 'reorder', ids: [...] } → reorder; otherwise ADD.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);

  const body = await readJson<Record<string, unknown>>(request);

  // REORDER — matches Go reorderAccounts (handler.go:1050) which is reached via
  // PUT /api/accounts/reorder in the Go router. The frontend also POSTs the same
  // shape, so we accept either {action:'reorder', ids} or {action:'reorder', user_ids}.
  if (body.action === 'reorder') {
    const ids = (body.ids as string[] | undefined) ?? (body.user_ids as string[] | undefined);
    if (!Array.isArray(ids) || ids.length === 0) {
      return jsonError(400, 'ids is required');
    }
    await store.reorder(ids);
    return Response.json({ ok: true });
  }

  // ADD — mirrors addAccount (handler.go:528) but, like validateAndSavePtKey,
  // resolves userId from pt_key via userInfo when only pt_key is supplied.
  const ptKey = (body.pt_key as string | undefined) ?? '';
  let userId = (body.user_id as string | undefined) ?? '';
  let nickname = (body.nickname as string | undefined) ?? '';
  const remark = (body.remark as string | undefined) ?? '';
  const apiToken = (body.api_token as string | undefined) ?? '';
  const defaultModel = (body.default_model as string | undefined) ?? 'GLM-5.1';
  const isDefaultRaw = body.is_default;
  const explicitDefault =
    typeof isDefaultRaw === 'boolean' ? isDefaultRaw : undefined;

  if (!ptKey) {
    return jsonError(400, 'pt_key is required');
  }

  if (!userId) {
    // Resolve userId + nickname from the upstream userInfo call.
    try {
      const resolved = await resolveFromPtKey(env, ptKey);
      userId = resolved.userId;
      if (!nickname) nickname = resolved.nickname;
    } catch (e) {
      return jsonError(400, e instanceof Error ? e.message : String(e));
    }
  }

  // Enforce the MAX_ACCOUNTS ceiling (Go addAccount does not, but the dashboard
  // flow does; env.MAX_ACCOUNTS is the single source of truth on the edge).
  const max = parseInt(env.MAX_ACCOUNTS || '10', 10);
  const count = await store.countAccounts();
  if (count >= max) {
    return jsonError(409, `已达到最大账号数限制 (${max})`);
  }

  // is_default: explicit body value wins; otherwise default to true iff no
  // account is currently marked default (matches validateAndSavePtKey:806-813).
  let isDefault: boolean;
  if (explicitDefault !== undefined) {
    isDefault = explicitDefault;
  } else {
    const all = await store.listAccounts();
    isDefault = !all.some((a) => a.isDefault);
  }

  const created = await store.addAccount({
    userId,
    nickname,
    remark,
    apiToken,
    ptKey,
    isDefault,
    defaultModel,
  });

  return Response.json({ ok: true, user_id: created.userId, nickname: created.nickname });
};

// --- PUT /api/accounts/reorder (mirrors Go router) ---
export const onRequestPut: PagesFunction<Env> = async ({ request, env }) => {
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  const body = await readJson<{ user_ids?: string[]; ids?: string[] }>(request);
  const ids = body.user_ids ?? body.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return jsonError(400, 'user_ids is required');
  }
  await store.reorder(ids);
  return Response.json({ ok: true });
};

// OPTIONS handled by root middleware. Unused names kept to avoid a notFound TS warning.
void notFound;
