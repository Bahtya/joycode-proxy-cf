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

  // Update each provided key. Values are coerced to string (Go stored TEXT).
  // Refuse to overwrite auth secrets from this endpoint (defence-in-depth);
  // those are managed by the auth handlers.
  const FORBIDDEN = new Set(['auth_jwt_secret', 'auth_password_hash']);
  const stmts: D1PreparedStatement[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (FORBIDDEN.has(key)) continue;
    const strVal = value == null ? '' : String(value);
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
