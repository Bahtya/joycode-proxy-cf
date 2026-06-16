// Retry helpers for transient upstream (JoyCode / its Cloudflare edge) errors.
//
// JoyCode sits behind Cloudflare; occasionally its edge returns transient errors
// (e.g. the "DNS points to local or disallowed IP" 403 page, 5xx, or a timeout)
// that clear within seconds. Retrying the upstream call a few times absorbs
// these so the client never sees them.
//
// SAFETY: only use withRetry around client.post / client.postStream. Those
// throw "API error {status}: {body}" on a non-200 BEFORE returning any response,
// and a transport/timeout error throws before any bytes are exchanged — so a
// retry happens entirely in the connect/initial-response phase, with nothing
// yet sent to the client. Never retry once streaming has begun (content already
// emitted can't be unsent, and a retry would double-generate / double-bill).

/** Promise-based sleep. Workers supports setTimeout. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Thrown when the upstream returned HTTP 200 but produced no usable completion
 * (no `choices`, or a non-SSE body for a stream request) — JoyCode's intermittent
 * "empty 200" flap. Treated as transient so withRetry retries it.
 */
export class EmptyUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmptyUpstreamError';
  }
}

/**
 * True if an error is a transient upstream/transport failure worth retrying:
 * timeouts/aborts, network errors, upstream 5xx, 429, and CDN/WAF edge blocks
 * (the Cloudflare "DNS points to local or disallowed IP" 403 page). Real 4xx
 * client errors (bad request, auth, content-policy 403 with a JSON body) are
 * NOT retried.
 */
export function isTransientUpstreamError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    // Non-Error throws (rare) — treat as transient/unknown only if string hints so.
    return /fetch failed|network|timeout|econnreset/i.test(String(err));
  }
  const name = err.name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  if (name === 'EmptyUpstreamError') return true;
  const msg = err.message.toLowerCase();
  if (/fetch failed|network|econnreset|socket hang up|terminated/.test(msg)) return true;

  // Upstream HTTP error shaped "API error {status}: {body}" (see client.post/postStream).
  const m = msg.match(/^api error (\d{3}):([\s\S]*)/);
  if (m) {
    const status = parseInt(m[1] ?? '', 10);
    const body = m[2] ?? '';
    if (status >= 500 && status < 600) return true; // 5xx
    if (status === 429) return true; // rate limited — back off and retry
    // 403 that is actually a CDN/WAF edge block page (not a real JoyCode auth/content 403).
    if (status === 403 && /dns points to local|<!doctype html>|cloudflare/.test(body)) return true;
  }
  return false;
}

/**
 * Parse the `max_retries` setting into a sane retry count: empty/missing/non-numeric
 * → `def` (default 3); otherwise a non-negative integer. (Settings are stored as
 * TEXT and may be '' when never explicitly saved.)
 */
export function parseRetries(raw: string | undefined | null, def = 3): number {
  if (raw == null || raw.trim() === '') return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(n, 0) : def;
}

/**
 * Run `fn`, retrying on transient upstream errors. `retries` is the number of
 * EXTRA attempts after the first (so retries=3 → up to 4 attempts), capped at a
 * total of 5. Non-finite/negative `retries` is coerced to 0, so `fn` is ALWAYS
 * invoked at least once. Exponential backoff (250ms→2000ms) between attempts.
 * Non-transient errors and the final attempt's error propagate to the caller.
 */
export async function withRetry<T>(fn: () => Promise<T>, retries: number): Promise<T> {
  const r = Number.isFinite(retries) ? Math.floor(retries) : 0;
  const attempts = Math.min(Math.max(r, 0) + 1, 5);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !isTransientUpstreamError(err)) break;
      await sleep(Math.min(250 * 2 ** i, 2000));
    }
  }
  throw lastErr;
}

