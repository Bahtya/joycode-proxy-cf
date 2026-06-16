// GET /api/upstream-models — live upstream model candidates for the Settings
// "selectable models" editor. Fetches JoyCode's modelList using the DEFAULT
// account's pt_key and maps joycode ModelInfo (modelId/label) → {id,name}.
//
// The upstream catalog rarely changes, so the result is cached in the settings
// table (underscore-prefixed keys, hidden from GET /api/settings) for ~1h and
// served stale on subsequent opens / on upstream failure. (P4)
// Companion endpoint: GET /api/models returns the admin-configured selectable list.
import type { Env } from '../../src/types';
import { createStore } from '../../src/store/d1';
import { clientFor } from '../../src/dashboard/account-views';
import { getSetting, setSetting } from '../../src/store/settings';

interface DashboardModel {
  id: string;
  name: string;
}

const CACHE_KEY = '_upstream_models_cache';
const CACHE_TS_KEY = '_upstream_models_cached_at';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function cachedResponse(raw: string | null): Response | null {
  if (!raw) return null;
  try {
    return Response.json({ models: JSON.parse(raw) as DashboardModel[] });
  } catch {
    return null;
  }
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  // Serve fresh cache without hitting the upstream.
  const cachedAt = Number(await getSetting(env.DB, CACHE_TS_KEY)) || 0;
  if (cachedAt && Date.now() - cachedAt < CACHE_TTL_MS) {
    const hit = cachedResponse(await getSetting(env.DB, CACHE_KEY));
    if (hit) return hit;
  }

  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  const account = await store.getDefaultAccount();
  if (!account) return Response.json({ models: [] });

  try {
    const list = await clientFor(env, account).listModels();
    const models: DashboardModel[] = list
      .map((m) => ({ id: m.modelId || m.label || '', name: m.label || m.modelId }))
      .filter((m) => m.id !== '');
    // Best-effort cache write (don't let a settings write failure fail the request).
    await Promise.all([
      setSetting(env.DB, CACHE_KEY, JSON.stringify(models)),
      setSetting(env.DB, CACHE_TS_KEY, String(Date.now())),
    ]).catch(() => {});
    return Response.json({ models });
  } catch {
    // Upstream failed: serve stale cache if any, else empty.
    return cachedResponse(await getSetting(env.DB, CACHE_KEY)) ?? Response.json({ models: [] });
  }
};
