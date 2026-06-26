// JDH (jdhgpt.jd.com) login — the CURRENT JoyCode login flow.
//
// The legacy passport.jd.com QR (appid=133) that pkg/auth/jdlogin.go (and our
// src/qr/jdlogin.ts) implemented is deprecated: JD now rejects the ticket
// validation with `returnCode=80`. JoyCode IDE 2.7.5+ logs in via browser-
// authorize + uuid polling against jdhgpt.jd.com (verified in the IDE bundle
// v3.8.57, 2026-06-17). This module ports that flow so the edge proxy can obtain
// a ptKey without the user manually pasting one.
//
// Flow:
//   loginInit: uuid → KV `qr:<uuid>` (TTL 300s) → { sessionId, url }
//     `url` is the pluginlogin page carrying the uuid; the user opens it (JD app
//      scans the QR of `url`, or clicks it to open in a browser) and completes
//      JD login there.
//   loginPoll: POST jdhgpt.jd.com/es/bigdata/pollLoginInfo {uuid,...} → once the
//     browser login completes, the response carries `data.ptKey`; we then run the
//     shared validateAndSave (userInfo check + upsert) and delete the KV session.
//
// KV key shape reuses jdlogin.ts's `qr:<sessionId>` namespace.

import type { Env } from '../types';
import { hexId } from '../util/id';
import { validateAndSave } from './jdlogin';
import { createStore } from '../store/d1';

const POLL_URL = 'http://jdhgpt.jd.com/es/bigdata/pollLoginInfo';
const PLUGINLOGIN_BASE = 'http://jdhgpt.jd.com/login/pluginlogin';
const KV_TTL_SECONDS = 300; // mirror the IDE's poll timeout headroom (it polls up to 300s)
const POLL_TIMEOUT_MS = 20000; // bounded per-call so the Worker doesn't hold a request too long; frontend retries
const IDE_APP_NAME = 'JoyCode';
const SOURCE = 'joyCoderFe';

export interface LoginInitResult {
  sessionId: string;
  url: string;
}

export type LoginPollStatus =
  | { status: 'waiting' }
  | { status: 'expired' }
  | { status: 'success'; userId: string; nickname: string }
  | { status: 'error'; message: string };

function kvKey(sessionId: string): string {
  return `qr:${sessionId}`;
}

function newSessionId(): string {
  // crypto.randomUUID exists on the Workers runtime; hexId is a fallback.
  const c = crypto as unknown as { randomUUID?: () => string };
  return typeof c.randomUUID === 'function' ? c.randomUUID() : hexId(16);
}

/**
 * Start a JDH login session: mint a uuid, persist it to KV (short TTL), and
 * return the pluginlogin URL the user opens to authorize. The same uuid is later
 * polled via loginPoll.
 */
export async function loginInit(env: Env): Promise<LoginInitResult> {
  const sessionId = newSessionId();
  const url = new URL(PLUGINLOGIN_BASE);
  url.searchParams.set('uuid', sessionId);
  url.searchParams.set('source', SOURCE);
  url.searchParams.set('ideAppName', IDE_APP_NAME);

  await env.QR_SESSIONS.put(
    kvKey(sessionId),
    JSON.stringify({ sessionId, createdAt: Date.now() }),
    { expirationTtl: KV_TTL_SECONDS },
  );
  return { sessionId, url: url.toString() };
}

/**
 * Poll an in-progress JDH login. Issues one bounded pollLoginInfo call; returns
 * `waiting` until the browser login completes (or on timeout/network error, so
 * the frontend simply retries), `success` once a ptKey is obtained and the
 * account is validated+saved, or `expired` if the KV session is gone.
 */
export async function loginPoll(env: Env, sessionId: string): Promise<LoginPollStatus> {
  const raw = await env.QR_SESSIONS.get(kvKey(sessionId));
  if (!raw) return { status: 'expired' };

  let resp: Response;
  try {
    resp = await fetch(POLL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ uuid: sessionId, sourceType: 'encrypt', source: SOURCE }),
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
  } catch {
    // Timeout / network blip → still pending; the caller retries.
    return { status: 'waiting' };
  }

  const text = await resp.text().catch(() => '');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const ptKey = extractPtKey(body);

  // First-run diagnostics: enough to confirm the response shape, never the key.
  const code = (body as { code?: unknown } | undefined)?.code;
  console.log(
    '[jdh-poll] session=', sessionId.slice(0, 8),
    'http=', resp.status, 'code=', code,
    'hasPtKey=', !!ptKey, 'bodyHead=', text.slice(0, 200),
  );

  if (!ptKey) return { status: 'waiting' };

  // ptKey obtained → validate via userInfo + upsert. makeDefault iff no default
  // exists yet (matches the QR/OAuth handlers' convention). For a re-login of an
  // existing account the upsert preserves its is_default regardless.
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  const accounts = await store.listAccounts();
  const makeDefault = !accounts.some((a) => a.isDefault);

  try {
    const r = await validateAndSave(env, ptKey, makeDefault);
    await env.QR_SESSIONS.delete(kvKey(sessionId));
    return { status: 'success', userId: r.userId, nickname: r.nickname };
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Extract the ptKey from a pollLoginInfo response. The exact JSON path was only
 * partially visible in the minified IDE bundle, so accept the likely shapes and
 * also recover it from `cookiesStr` (`sso.jd.com=<value>`) the way the IDE's
 * loginResultCheck parser does.
 */
function extractPtKey(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const b = body as Record<string, unknown>;
  const data = b.data as Record<string, unknown> | undefined;

  if (data && typeof data['ptKey'] === 'string' && data['ptKey']) {
    return data['ptKey'];
  }
  // Nested (axios-style: HTTP body `.data` → wrapper `.data` → fields).
  const inner = data && (data['data'] as Record<string, unknown> | undefined);
  if (inner && typeof inner['ptKey'] === 'string' && inner['ptKey']) {
    return inner['ptKey'];
  }
  // From cookiesStr: ptKey is the sso.jd.com cookie value.
  const cookies =
    (typeof data?.['cookiesStr'] === 'string' && (data['cookiesStr'] as string)) ||
    (typeof b['cookiesStr'] === 'string' && (b['cookiesStr'] as string)) ||
    '';
  const m = cookies.match(/sso\.jd\.com=([^;]+)/);
  return m && m[1] ? m[1] : '';
}
