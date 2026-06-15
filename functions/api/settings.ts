// /api/settings — GET returns all settings; PUT updates a batch.
// Ports pkg/dashboard/handler.go handleSettings + store.GetSettings/SetSettings.
// Response shapes (web/src/api.ts):
//   GET  → { settings: { [key: string]: string } }
//   PUT  → { ok: true }
import type { Env } from '../../src/types';
import { getSetting, setSetting } from '../../src/store/settings';

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const settings: Record<string, string> = {};
  for (const row of results ?? []) {
    // Hide internal/cache keys (underscore-prefixed, e.g. _upstream_models_*). (P4)
    if (row.key.startsWith('_')) continue;
    settings[row.key] = row.value;
  }
  return Response.json({ settings });
};

export const onRequestPut: PagesFunction<Env> = async ({ request, env }) => {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ detail: 'invalid JSON body' }, { status: 400 });
  }

  // Update each provided key. Allowlist (not denylist): only known writable keys are
  // accepted; auth secrets are managed by the auth handlers and never writable here.
  const ALLOWED = new Set([
    'default_model',
    'default_max_tokens',
    'max_retries',
    'request_timeout',
    'max_connections',
    'enable_request_logging',
    'log_retention_days',
    'selectable_models',
  ]);
  const stmts: D1PreparedStatement[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (!ALLOWED.has(key)) continue;
    let strVal = value == null ? '' : String(value);
    if (key === 'selectable_models') {
      // Validate it round-trips as a JSON string array (defence-in-depth; getModelList
      // also validates on read, but reject early with a clear error here).
      try {
        const parsed: unknown = JSON.parse(strVal);
        if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
          return Response.json({ detail: 'selectable_models must be a JSON string array' }, { status: 400 });
        }
      } catch {
        return Response.json({ detail: 'selectable_models must be valid JSON' }, { status: 400 });
      }
    }
    stmts.push(
      env.DB
        .prepare(
          "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
        )
        .bind(key, strVal)
    );
  }
  if (stmts.length > 0) await env.DB.batch(stmts);

  return Response.json({ ok: true });
};

// Method not allowed for anything else.
export const onRequest: PagesFunction<Env> = async (ctx) => {
  const m = ctx.request.method.toUpperCase();
  if (m === 'GET' || m === 'PUT') return ctx.next();
  return Response.json({ detail: 'method not allowed' }, { status: 405 });
};

// Re-export the scalar helpers so callers importing from this module still work.
export { getSetting, setSetting };
