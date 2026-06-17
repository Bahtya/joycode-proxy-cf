// Companion Cron Worker — refreshes expiring pt_keys on a schedule.
//
// Pages Functions cannot run scheduled() handlers, so the keepalive loop lives
// in this standalone Worker (see wrangler.cron.toml). It is a direct port of
// pkg/keepalive/keepalive.go:
//   - Start/checkStale  (keepalive.go:65-144): every tick, list stale accounts
//     (credential_refreshed_at empty or older than the TTL) and refresh each,
//     sleeping 5s between accounts.
//   - checkOne          (keepalive.go:148-242): call JoyCode UserInfoWithRefresh;
//     if the returned ptKey differs, rotate the stored pt_key, revalidate, and
//     bump refreshed_at. On failure mark the credential invalid.
//
// The cron wrangler config only binds DB + PTKEY_ENC_KEY + JOYCODE_BASE_URL +
// JOYCODE_CLIENT_VERSION. It does NOT bind QR_SESSIONS / ASSETS / JWT_SECRET, so
// we use a narrow local CronEnv type instead of the full Env (which would
// require bindings the cron lacks). Log retention is read from the D1 settings
// table (set via the dashboard), not an env var.
//
// Workers runtime notes: app code runs on the Workers runtime here, so
// new Date() and setTimeout are both available and used as in the Go original.

import { createStore, RAW_LIVE_WINDOW_DAYS } from '../../src/store/d1';
import { createJoyClient } from '../../src/joycode/client';
import { getIntSetting } from '../../src/store/settings';

/**
 * Bindings available to the cron Worker. Intentionally narrower than the full
 * Env (no QR_SESSIONS / ASSETS / JWT_SECRET) — those are
 * not bound in wrangler.cron.toml and assuming them would break type checking.
 */
type CronEnv = {
  DB: D1Database;
  PTKEY_ENC_KEY: string;
  JOYCODE_BASE_URL: string;
  JOYCODE_CLIENT_VERSION: string;
};

/** Milliseconds to wait between accounts, matching Go's 5s sleep (keepalive.go:133). */
const ACCOUNT_DELAY_MS = 5000;

/** Accounts older than this many hours are considered stale and get re-checked. */
const REFRESH_TTL_HOURS = 1;

/**
 * scheduled handler — one keepalive round per cron tick.
 *
 * Mirrors keepalive.go checkStale (99-144) + checkOne (148-242):
 *  1. list stale accounts
 *  2. for each: UserInfoWithRefresh; rotate pt_key on change, else mark ok;
 *     on error mark invalid. Sleep 5s between accounts.
 *  3. finally, trim old request logs.
 */
async function runKeepalive(env: CronEnv): Promise<void> {
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);

  const stale = await store.listStaleAccounts(REFRESH_TTL_HOURS);
  if (stale.length === 0) {
    // Nothing to do this round; still run log cleanup below.
  }

  for (let i = 0; i < stale.length; i++) {
    const account = stale[i]!;
    if (!account.userId) continue;

    const client = createJoyClient({
      ptKey: account.ptKey,
      userId: account.userId,
      baseURL: env.JOYCODE_BASE_URL,
      clientVersion: env.JOYCODE_CLIENT_VERSION,
    });

    try {
      const fresh = await client.userInfoWithRefresh();

      if (fresh && fresh !== account.ptKey) {
        // pt_key rotated upstream — persist the new key (store.updatePtKey handles
        // AES encryption internally), mark valid, bump refreshed_at, and record
        // the rotation. Matches keepalive.go:189-224.
        await store.updatePtKey(account.userId, fresh);
        await store.setCredentialValid(account.userId, 1);
        await store.updateCredentialRefreshedAt(account.userId);
        await store.setKeepaliveStatus(account.userId, {
          status: 'refreshed',
          message: 'pt_key rotated',
          lastRefreshed: new Date().toISOString().replace('T', ' ').substring(0, 19),
        });
      } else {
        // Still valid, no rotation needed. Mark valid + bump refreshed_at so this
        // account is not re-checked next cycle. Matches keepalive.go:225-234.
        await store.setCredentialValid(account.userId, 1);
        await store.updateCredentialRefreshedAt(account.userId);
        await store.setKeepaliveStatus(account.userId, { status: 'ok' });
      }
    } catch (e) {
      // Validation/refresh failed — mark the credential invalid and record the
      // error. Matches keepalive.go:166-181.
      await store.setCredentialValid(account.userId, 0);
      await store.setKeepaliveStatus(account.userId, {
        status: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }

    // Pace the round (5s between accounts), but skip the delay after the last one
    // so the cron finishes promptly. Matches keepalive.go:132-134.
    if (i < stale.length - 1) {
      await new Promise((r) => setTimeout(r, ACCOUNT_DELAY_MS));
    }
  }

  // Roll raw request_logs older than the live window into stats_daily (deleting
  // the rolled raw rows), then prune old stats_daily + any stray old raw.
  // Retention reads the admin setting (log_retention_days); previously this used
  // a vestigial, never-bound env var that always defaulted to 30, so the
  // dashboard's retention field had no effect.
  const tzOff = await getIntSetting(env.DB, 'tz_offset', 8);
  await store.rollupLogs(RAW_LIVE_WINDOW_DAYS, tzOff);
  const retentionDays = await getIntSetting(env.DB, 'log_retention_days', 30);
  await store.cleanupOldLogs(retentionDays > 0 ? retentionDays : 30, tzOff);
}

// Color-gateway function ID for chat (was the legacy path; the client now signs
// it as a functionId against api-ai.jd.com).
const PROBE_CHAT_ENDPOINT = 'chat_completions';

/**
 * One-minute upstream availability probe for the dashboard card. Pings the
 * endpoint (network RTT) and issues a single tiny chat request (max_tokens:1);
 * ok iff the chat returned choices. NOT retried — the sample reflects JoyCode's
 * raw health so flaps show red (real traffic is retried by the proxy). Records
 * one row + prunes rows older than 60 minutes.
 */
async function runAvailabilityProbe(env: CronEnv): Promise<void> {
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  const account = await store.getDefaultAccount();
  if (!account || !account.userId) return; // no account configured — nothing to probe

  const client = createJoyClient({
    ptKey: account.ptKey,
    userId: account.userId,
    baseURL: env.JOYCODE_BASE_URL,
    clientVersion: env.JOYCODE_CLIENT_VERSION,
  });

  // 1) Endpoint ping — pure network reachability/RTT, free (no quota).
  let pingMs = 0;
  try {
    const t = Date.now();
    await fetch(env.JOYCODE_BASE_URL, { method: 'GET' });
    pingMs = Date.now() - t;
  } catch {
    pingMs = 0;
  }

  // 2) Single chat probe — ok iff choices present.
  let chatMs = 0;
  let ok = 0;
  let error = '';
  try {
    const t = Date.now();
    const resp = await client.post(PROBE_CHAT_ENDPOINT, {
      model: account.defaultModel || 'GLM-5.1',
      max_tokens: 1,
      stream: false,
      messages: [{ role: 'user', content: '.' }],
    });
    chatMs = Date.now() - t;
    ok = Array.isArray(resp?.choices) && resp.choices.length > 0 ? 1 : 0;
    if (!ok) error = 'empty response (no choices)';
  } catch (e) {
    ok = 0;
    error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  }

  await store.recordAvailabilitySample(ok, chatMs, pingMs, error);
}

export default {
  /** Scheduled (cron) entrypoint. */
  async scheduled(
    event: ScheduledEvent,
    env: CronEnv,
    _ctx: ExecutionContext,
  ): Promise<void> {
    // Two cron triggers: the 1-min one runs the availability probe; the 10-min
    // one runs keepalive. (Cloudflare fires once per matching cron; event.cron
    // identifies which fired.)
    if (event.cron === '* * * * *') {
      await runAvailabilityProbe(env);
    } else {
      await runKeepalive(env);
    }
  },

  /** Trivial health-check fetch handler. Keeps the Worker deployable/invokeable. */
  async fetch(): Promise<Response> {
    return new Response('ok', { status: 200 });
  },
};
