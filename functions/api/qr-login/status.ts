// GET /api/qr-login/status?session=<id> — port of handleQRLoginStatus (handler.go:916-1001).
//
// Polls an in-progress QR login. Returns one of:
//   { status: "waiting" }
//   { status: "scanned" }
//   { status: "expired" }
//   { status: "verification_required", risk_code, verify_url }
//   { status: "error", message }
//   { status: "success", ok, user_id, nickname }   // account persisted
//
// JWT-gated (only /api/qr-login/init is whitelisted in _middleware.ts).
// On a confirmed login the new account is persisted via store.addAccount with
// is_default = (store.countAccounts() === 0), matching handler.go:973-991.

import type { Env } from '../../../src/types';
import { qrPoll } from '../../../src/qr/jdlogin';
import { createStore } from '../../../src/store/d1';
import { jsonError } from '../../../src/util/http';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session') ?? '';
  if (!sessionId) {
    return jsonError(400, 'missing session parameter');
  }

  const result = await qrPoll(env, sessionId);
  // Log only safe fields — never JSON.stringify(result), which on success contains
  // the freshly captured pt_key (a credential). (S1)
  console.log('[qr-status] session=', sessionId.slice(0, 12), 'status=', result.status);

  // Non-success states pass straight through (handler.go:950-956).
  if (result.status !== 'success') {
    const body: Record<string, unknown> = { status: result.status };
    if (result.status === 'error') body.message = result.message;
    if (result.status === 'verification_required') {
      body.risk_code = result.riskCode;
      body.verify_url = result.verifyUrl;
    }
    return Response.json(body);
  }

  // Success: persist the account (handler.go:973-991).
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  const isDefault = (await store.countAccounts()) === 0;
  try {
    await store.addAccount({
      userId: result.userId,
      ptKey: result.ptKey,
      nickname: result.nickname,
      isDefault,
      defaultModel: 'GLM-5.1',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // handler.go:982-990 — login succeeded but the save failed.
    return Response.json({
      status: 'success',
      ok: false,
      user_id: result.userId,
      message: '登录成功但保存账号失败: ' + msg,
    });
  }

  return Response.json({
    status: 'success',
    ok: true,
    user_id: result.userId,
    nickname: result.nickname,
  });
};
