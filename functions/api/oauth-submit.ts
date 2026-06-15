// POST /api/oauth-submit — port of handleOAuthSubmit (handler.go:858-889).
//
// Manual-submit OAuth flow: the user pastes a pt_key captured from JoyCode and
// we validate+save it. Returns { ok, user_id, nickname } on success.
//
// Whitelisted in functions/api/_middleware.ts (no JWT required) — this is the
// cross-machine authorization path used before any dashboard session exists.

import type { Env } from '../../src/types';
import { validateAndSave } from '../../src/qr/jdlogin';
import { createStore } from '../../src/store/d1';
import { readJson, jsonError } from '../../src/util/http';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<{ pt_key?: unknown }>(request);
  const ptKey = typeof body.pt_key === 'string' ? body.pt_key : '';

  // is_default = true iff no account is currently default (handler.go:806-813).
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  const accounts = await store.listAccounts();
  const makeDefault = !accounts.some((a) => a.isDefault);

  try {
    const { userId, nickname } = await validateAndSave(env, ptKey, makeDefault);
    return Response.json({ ok: true, user_id: userId, nickname });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonError(400, msg);
  }
};
