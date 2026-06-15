// POST /api/accounts-clear-all — delete every account.
// Ports pkg/dashboard/handler.go handleClearAllAccounts + store.ClearAllAccounts.
// Response shape (web/src/api.ts clearAllAccounts): { ok: true, count: number }.
import type { Env } from '../../src/types';
import { createStore } from '../../src/store/d1';

export const onRequestPost: PagesFunction<Env> = async ({ env }) => {
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  // D1's clearAllAccounts() returns void; capture the count first so we can
  // report it (Go returns DELETE rows-affected).
  const count = await store.countAccounts();
  await store.clearAllAccounts();
  return Response.json({ ok: true, count });
};
