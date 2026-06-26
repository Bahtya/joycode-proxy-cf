// GET /api/qr-login/status?session=<id> — poll a JDH login session.
//
// One bounded pollLoginInfo call per request; returns:
//   { status: "waiting" }      // not completed yet (or timeout) — caller retries
//   { status: "expired" }      // KV session gone (TTL exceeded)
//   { status: "error", message }
//   { status: "success", ok, user_id, nickname }   // ptKey captured, account saved
//
// On success the account is persisted inside loginPoll (validateAndSave →
// addAccount upsert: a re-login of an existing userId refreshes its ptKey in
// place; a new account is added, made default iff none exists yet).
//
// JWT-gated (only /api/qr-login/init is whitelisted in _middleware.ts).

import type { Env } from '../../../src/types';
import { loginPoll } from '../../../src/qr/jdhlogin';
import { jsonError } from '../../../src/util/http';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session') ?? '';
  if (!sessionId) {
    return jsonError(400, 'missing session parameter');
  }

  const result = await loginPoll(env, sessionId);
  // Log only safe fields — never the captured ptKey.
  console.log('[qr-status] session=', sessionId.slice(0, 12), 'status=', result.status);

  if (result.status === 'success') {
    return Response.json({
      status: 'success',
      ok: true,
      user_id: result.userId,
      nickname: result.nickname,
    });
  }

  const body: Record<string, unknown> = { status: result.status };
  if (result.status === 'error') body.message = result.message;
  return Response.json(body);
};
