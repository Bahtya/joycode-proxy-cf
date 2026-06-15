// JD QR-scan login — port of pkg/auth/jdlogin.go.
//
// THE HARD PART (and why this file exists in its own module): the Go original
// uses net/http/cookiejar to hold the JD cookie jar IN PROCESS across the three
// QR lifecycle calls (QRInit → QRPollStatus/check → qrCodeTicketValidation).
// Cloudflare Workers have NO in-process state between requests — each
// onRequest* invocation is a fresh isolate — so we externalize the cookie jar
// to KV (env.QR_SESSIONS). Every outbound JD request replays the stored
// Set-Cookie values as a manual `Cookie` header, and every response's
// `set-cookie` is merged back into the stored map. This reproduces cookiejar
// semantics over a stateless transport.
//
// KV record shape (key "qr:<sessionId>"):
//   { sessionId, wlfstkSmdl, cookies: Record<name,value>, createdAt }
// expirationTtl: 180s (Go also expires sessions after 3 minutes, jdlogin.go:117).

import type { Env } from '../types';
import { hexId } from '../util/id';
import { cookieValue } from '../util/http';
import { createJoyClient } from '../joycode/client';
import { Store } from '../store/d1';

// --- Constants (jdlogin.go:25-30) ---

const QR_SHOW_URL = 'https://qr.m.jd.com/show?appid=133&size=147&t=';
const QR_CHECK_URL = 'https://qr.m.jd.com/check?appid=133&token=';
const QR_VALID_URL = 'https://passport.jd.com/uc/qrCodeTicketValidation?t=';
const JD_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

const KV_TTL_SECONDS = 180;

// --- Types ---

/** A cookie map persisted in KV across the QR lifecycle (our cookiejar stand-in). */
type CookieJar = Record<string, string>;

interface QRSessionRecord {
  sessionId: string;
  wlfstkSmdl: string;
  cookies: CookieJar;
  createdAt: number;
}

/** Result of a confirmed QR login (subset of Go's QRLoginResult that callers need). */
export interface QRLoginResult {
  ptKey: string;
  ptPin: string;
  userId: string;
  nickname: string;
}

/** Status returned by qrPoll. Mirrors the Go QRPollStatus return values. */
export type QRPollStatus =
  | { status: 'waiting' }
  | { status: 'scanned' }
  | { status: 'expired' }
  | { status: 'success'; ptKey: string; userId: string; nickname: string }
  | { status: 'verification_required'; riskCode: number; verifyUrl: string }
  | { status: 'error'; message: string };

export interface QRInitResult {
  sessionId: string;
  qrImage: string; // "data:image/png;base64,...."
}

// --- KV helpers ---

function kvKey(sessionId: string): string {
  return `qr:${sessionId}`;
}

async function readSession(env: Env, sessionId: string): Promise<QRSessionRecord | null> {
  const raw = await env.QR_SESSIONS.get(kvKey(sessionId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as QRSessionRecord;
  } catch {
    return null;
  }
}

async function writeSession(env: Env, session: QRSessionRecord): Promise<void> {
  await env.QR_SESSIONS.put(kvKey(session.sessionId), JSON.stringify(session), {
    expirationTtl: KV_TTL_SECONDS,
  });
}

async function deleteSession(env: Env, sessionId: string): Promise<void> {
  await env.QR_SESSIONS.delete(kvKey(sessionId));
}

// --- Cookie-jar emulation ---

/**
 * Build a `Cookie` request-header value from the stored jar. Go's cookiejar
 * handles host/path matching automatically; we simply replay every cookie we
 * have collected for the JD properties (which is what the jar effectively does
 * for these same-host requests).
 */
function cookieHeader(jar: CookieJar): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * The Workers runtime exposes `Headers.getSetCookie()` (returns the explicit
 * Set-Cookie list), but older @cloudflare/workers-types versions lack it on the
 * interface. We declare the minimal shape we need and feature-detect at runtime.
 */
interface HeadersWithSetCookie extends Headers {
  getSetCookie?: () => string[];
}

/**
 * Merge a response's Set-Cookie headers into the jar. A Response may carry
 * multiple Set-Cookie lines; Workers exposes them all via getSetCookie().
 * We also fall back to parsing a combined header (some upstreams comma-join).
 */
function mergeSetCookies(jar: CookieJar, res: Response): CookieJar {
  const next: CookieJar = { ...jar };
  // Preferred modern API: explicit Set-Cookie list.
  const h = res.headers as HeadersWithSetCookie;
  const setCookieList = typeof h.getSetCookie === 'function' ? h.getSetCookie() : [];
  for (const sc of setCookieList) {
    const name = sc.split('=', 1)[0]?.trim();
    if (!name) continue;
    const v = cookieValue(sc, name);
    if (v != null) next[name] = v;
  }
  return next;
}

// --- JSONP parser (jdlogin.go:134-148) ---

interface CheckResult {
  code: number;
  ticket?: string;
}

/**
 * Parse a JSONP response body like `jsonpCallback({...})` into the inner object.
 * Mirrors jdlogin.go:134-148 (find first "(" and last ")"). Returns null if the
 * body is not JSONP-wrapped or the payload fails to parse — callers treat that
 * the same way Go does ("waiting").
 */
function parseJsonp<T>(body: string): T | null {
  const start = body.indexOf('(');
  const end = body.lastIndexOf(')');
  if (start < 0 || end < 0 || end <= start) return null;
  const payload = body.slice(start + 1, end);
  try {
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
}

// --- qrInit (jdlogin.go:64-106) ---

/**
 * Start a new QR login session: fetch the QR PNG, capture the `wlfstk_smdl`
 * token cookie, persist the session to KV, return the image as a data URL.
 */
export async function qrInit(env: Env): Promise<QRInitResult> {
  const t = Date.now();
  const url = `${QR_SHOW_URL}${t}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': JD_USER_AGENT,
      Referer: 'https://passport.jd.com/new/login.aspx',
    },
  });
  if (!res.ok) {
    throw new Error(`request QR code: status ${res.status}`);
  }

  // PNG bytes → base64. arrayBuffer() works on the decompressed body.
  const pngBuf = await res.arrayBuffer();
  const b64 = bufferToBase64(pngBuf);

  // Capture wlfstk_smdl from Set-Cookie (jdlogin.go:85-94).
  const jar = mergeSetCookies({}, res);
  const wlfstkSmdl = jar['wlfstk_smdl'];
  if (!wlfstkSmdl) {
    throw new Error('wlfstk_smdl cookie not found');
  }

  const sessionId = hexId();
  const record: QRSessionRecord = {
    sessionId,
    wlfstkSmdl,
    cookies: jar,
    createdAt: Date.now(),
  };
  await writeSession(env, record);

  return { sessionId, qrImage: `data:image/png;base64,${b64}` };
}

/** Encode an ArrayBuffer to a base64 string without Node APIs. */
function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000; // avoid call-stack overflow on large arrays
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// --- qrPoll (jdlogin.go:110-187 + validateAndFetchInfo:223-313 + buildLoginResult:315-341) ---

/**
 * Poll the scan status of a QR login session. Reads the session from KV
 * (missing → expired), replays the stored cookie jar against the check
 * endpoint, parses the JSONP result, and on confirmation runs the full
 * ticket-validation → pt_key extraction → userInfo resolution chain.
 *
 * On success the KV session is deleted and the resolved account info returned.
 */
export async function qrPoll(env: Env, sessionId: string): Promise<QRPollStatus> {
  const session = await readSession(env, sessionId);
  if (!session) {
    // jdlogin.go:114-116 — session not found (or KV-evicted) → expired.
    return { status: 'expired' };
  }

  // jdlogin.go:122 — check endpoint with the wlfstk_smdl token as `token`.
  const t = Date.now();
  const checkUrl = `${QR_CHECK_URL}${encodeURIComponent(session.wlfstkSmdl)}&callback=jsonpCallback&_=${t}`;

  const checkRes = await fetch(checkUrl, {
    headers: {
      'User-Agent': JD_USER_AGENT,
      Referer: 'https://passport.jd.com/new/login.aspx',
      Cookie: cookieHeader(session.cookies),
    },
  });
  // Merge any new cookies back for the (possible) follow-up validation request.
  session.cookies = mergeSetCookies(session.cookies, checkRes);

  const bodyText = await checkRes.text();
  const check = parseJsonp<CheckResult>(bodyText);
  if (!check || typeof check.code !== 'number') {
    // jdlogin.go:137-140 / 146-149 — not JSONP or parse failed → waiting.
    await writeSession(env, session);
    return { status: 'waiting' };
  }

  switch (check.code) {
    case 200: {
      const ticket = check.ticket ?? '';
      if (!ticket) {
        await deleteSession(env, sessionId);
        return { status: 'error', message: 'ticket is empty' };
      }
      try {
        const result = await validateAndFetchInfo(env, session, ticket);
        await deleteSession(env, sessionId);
        return {
          status: 'success',
          ptKey: result.ptKey,
          userId: result.userId,
          nickname: result.nickname,
        };
      } catch (e) {
        await deleteSession(env, sessionId);
        const msg = e instanceof Error ? e.message : String(e);
        // Risk-control error surfaces as verification_required (jdlogin.go:276-282).
        const risk = e instanceof QRVerifyNeededError ? e : null;
        if (risk) {
          return { status: 'verification_required', riskCode: risk.riskCode, verifyUrl: risk.verifyUrl };
        }
        return { status: 'error', message: msg };
      }
    }
    case 201:
      await writeSession(env, session);
      return { status: 'waiting' };
    case 202:
      await writeSession(env, session);
      return { status: 'scanned' };
    case 203:
    case 204:
    case 205:
      // jdlogin.go:171-178 — expired / canceled.
      await deleteSession(env, sessionId);
      return { status: 'expired' };
    case 257:
      await deleteSession(env, sessionId);
      return { status: 'error', message: 'JD 服务端参数异常 (code 257)' };
    default:
      await deleteSession(env, sessionId);
      return { status: 'error', message: `未知状态码: ${check.code}` };
  }
}

// --- validateAndFetchInfo (jdlogin.go:223-313) + fetchUserInfoWithPtKey (343-377) ---

class QRVerifyNeededError extends Error {
  constructor(public riskCode: number, public verifyUrl: string) {
    super(`JD 风控验证 (riskCode=${riskCode})，请在浏览器中完成安全验证`);
    this.name = 'QRVerifyNeededError';
  }
}

/**
 * Validate the ticket, scrape pt_key/pt_pin from the redirect Set-Cookie chain,
 * then resolve JoyCode userId + nickname via the SaaS userInfo API.
 *
 * Mirrors jdlogin.go:223-313. Go relies on the shared cookiejar collecting
 * pt_key across redirects; here we follow manually with redirect:'follow'
 * (Workers replays no cookies across redirects automatically, but JD sets the
 * pt_key cookie on the final response's Set-Cookie, which we capture via
 * mergeSetCookies). If pt_key is absent from the redirect chain we then parse
 * the JSON body and optionally follow its `url` (jdlogin.go:284-303).
 */
async function validateAndFetchInfo(
  env: Env,
  session: QRSessionRecord,
  ticket: string,
): Promise<QRLoginResult> {
  const validUrl = `${QR_VALID_URL}${encodeURIComponent(ticket)}`;

  // Step 1: ticket validation with redirect:'follow' (jdlogin.go:223-251).
  const validRes = await fetch(validUrl, {
    redirect: 'follow',
    headers: {
      'User-Agent': JD_USER_AGENT,
      Referer: 'https://passport.jd.com/new/login.aspx',
      Cookie: cookieHeader(session.cookies),
    },
  });
  // The redirect chain sets pt_key on the jar.
  session.cookies = mergeSetCookies(session.cookies, validRes);

  let ptKey = session.cookies['pt_key'] ?? '';
  let ptPin = session.cookies['pt_pin'] ?? '';

  if (ptKey) {
    // jdlogin.go:256-259 — pt_key found directly from the request chain.
    return buildLoginResult(env, ptKey, ptPin);
  }

  // Step 2: parse JSON body for returnCode/riskCode/url (jdlogin.go:262-282).
  const bodyText = await validRes.text();
  let parsed: { returnCode?: number; riskCode?: number; url?: string } | null = null;
  try {
    parsed = JSON.parse(bodyText) as { returnCode?: number; riskCode?: number; url?: string };
  } catch {
    parsed = null;
  }

  if (parsed) {
    if (typeof parsed.returnCode === 'number' && parsed.returnCode !== 0) {
      throw new Error(`ticket validation failed (code=${parsed.returnCode})`);
    }
    if (typeof parsed.riskCode === 'number' && parsed.riskCode !== 0) {
      throw new QRVerifyNeededError(parsed.riskCode, parsed.url ?? '');
    }

    // Step 3: follow the JSON-provided URL (jdlogin.go:284-303).
    if (typeof parsed.url === 'string' && parsed.url !== '') {
      let followURL = parsed.url;
      if (followURL.startsWith('http://')) followURL = 'https://' + followURL.slice(7);
      try {
        const rRes = await fetch(followURL, {
          redirect: 'follow',
          headers: {
            'User-Agent': JD_USER_AGENT,
            Referer: 'https://passport.jd.com/new/login.aspx',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            Cookie: cookieHeader(session.cookies),
          },
        });
        session.cookies = mergeSetCookies(session.cookies, rRes);
      } catch {
        // jdlogin.go:296-298 — follow failed is non-fatal; fall through to final check.
      }
      ptKey = session.cookies['pt_key'] ?? '';
      ptPin = session.cookies['pt_pin'] ?? '';
    }
  }

  // Step 4: final check (jdlogin.go:305-312).
  if (!ptKey) {
    throw new Error('pt_key cookie not found after validation');
  }

  return buildLoginResult(env, ptKey, ptPin);
}

/**
 * Resolve JoyCode userId + realName from a pt_key by calling the SaaS userInfo
 * endpoint via the shared createJoyClient. Combines Go's buildLoginResult
 * (jdlogin.go:315-341) and fetchUserInfoWithPtKey (343-377). The client's
 * userInfo() already issues the exact request Go hand-rolls (POST
 * /api/saas/user/v1/userInfo with ptKey header + loginType N_PIN_PC), so we
 * reuse it rather than re-implement the fetch.
 */
async function buildLoginResult(env: Env, ptKey: string, ptPin: string): Promise<QRLoginResult> {
  const client = createJoyClient({
    ptKey,
    userId: '', // unknown until userInfo resolves it
    baseURL: env.JOYCODE_BASE_URL,
    saasBaseURL: env.JOYCODE_SAAS_BASE_URL,
    clientVersion: env.JOYCODE_CLIENT_VERSION,
  });

  let info: any;
  try {
    info = await client.userInfo();
  } catch (e) {
    throw new Error('userInfo request failed: ' + (e instanceof Error ? e.message : String(e)));
  }

  const code = info?.code;
  if (typeof code !== 'number' || code !== 0) {
    const msg = (info && typeof info.msg === 'string' && info.msg) || 'unknown error';
    throw new Error(`userInfo error (code=${code}): ${msg}`);
  }

  let userId = '';
  let nickname = '';
  const data = info?.data;
  if (data && typeof data === 'object') {
    const id = (data as Record<string, unknown>).userId;
    const name = (data as Record<string, unknown>).realName;
    if (typeof id === 'string' && id !== '') userId = id;
    if (typeof name === 'string' && name !== '') nickname = name;
  }
  if (!userId) {
    throw new Error('无法从 JoyCode API 获取用户ID');
  }
  if (!nickname) nickname = userId;

  return { ptKey, ptPin, userId, nickname };
}

// --- validateAndSave (handler.go:773-821) ---
//
// Shared by the browser OAuth callback + manual submit flows: validate a pt_key
// against the JoyCode userInfo API, resolve userId/nickname, enforce MAX_ACCOUNTS,
// and persist the account. Returns the resolved userId + nickname.

export interface ValidateAndSaveResult {
  userId: string;
  nickname: string;
}

/**
 * Validate a pt_key and save the resulting account. Mirrors
 * handler.go:validateAndSavePtKey (773-821) plus MAX_ACCOUNTS enforcement.
 *
 * @param env           Worker env.
 * @param ptKey         the JD pt_key to validate.
 * @param makeDefault   whether to mark the new account as default. The Go code
 *                      sets is_default=true iff no existing account is default;
 *                      callers (oauth-callback/oauth-submit) pass that boolean in.
 */
export async function validateAndSave(
  env: Env,
  ptKey: string,
  makeDefault: boolean,
): Promise<ValidateAndSaveResult> {
  if (!ptKey) {
    throw new Error('missing pt_key');
  }

  const client = createJoyClient({
    ptKey,
    userId: '',
    baseURL: env.JOYCODE_BASE_URL,
    saasBaseURL: env.JOYCODE_SAAS_BASE_URL,
    clientVersion: env.JOYCODE_CLIENT_VERSION,
  });

  let info: any;
  try {
    info = await client.userInfo();
  } catch (e) {
    throw new Error('userInfo validation failed: ' + (e instanceof Error ? e.message : String(e)));
  }

  const code = info?.code;
  if (typeof code !== 'number' || code !== 0) {
    const msg = (info && typeof info.msg === 'string' && info.msg) || 'unknown error';
    throw new Error(`userInfo API error (code=${code}): ${msg}`);
  }

  let userId = '';
  let nickname = '';
  const data = info?.data;
  if (data && typeof data === 'object') {
    const id = (data as Record<string, unknown>).userId;
    const name = (data as Record<string, unknown>).realName;
    if (typeof id === 'string' && id !== '') userId = id;
    if (typeof name === 'string' && name !== '') nickname = name;
  }
  if (!nickname) nickname = userId;
  if (!userId) {
    throw new Error('无法获取用户ID，请重新授权');
  }

  // Enforce MAX_ACCOUNTS before the insert (the Go store enforces a cap too;
  // we check here so the error message is actionable for the OAuth flows).
  const maxAccounts = parseInt(env.MAX_ACCOUNTS ?? '10', 10);
  const store = new Store(env.DB, env.PTKEY_ENC_KEY);
  if (Number.isFinite(maxAccounts) && maxAccounts > 0) {
    const count = await store.countAccounts();
    // Allow the save if this account already exists (refresh) or we're under cap.
    const existing = await store.getAccount(userId);
    if (!existing && count >= maxAccounts) {
      throw new Error(`已达到最大账号数限制 (${maxAccounts})`);
    }
  }

  await store.addAccount({
    userId,
    ptKey,
    nickname,
    isDefault: makeDefault,
    defaultModel: 'GLM-5.1',
  });

  return { userId, nickname };
}
