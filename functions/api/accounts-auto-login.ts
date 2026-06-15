// /api/accounts-auto-login — POST.
// Ports pkg/dashboard/handler.go: handleAutoLogin (558-641).
//
// IMPORTANT DEVIATION: the Go handler calls auth.LoadFromSystem() to pull JoyCode
// credentials from the local IDE's state.vscdb on disk. That is impossible on the
// Cloudflare edge (no host filesystem), so the client must supply the credential.
// We accept { pt_key, user_id? } in the body and then run the same validate-via-
// userInfo → save-account flow as the Go handler (and validateAndSavePtKey:773).
//
// JWT-gated by functions/api/_middleware.ts.
import type { Env } from '../../src/types';
import { createStore } from '../../src/store/d1';
import { createJoyClient } from '../../src/joycode/client';
import { readJson, jsonError } from '../../src/util/http';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<{ pt_key?: string; user_id?: string }>(request);
  const ptKey = body.pt_key ?? '';
  if (!ptKey) {
    return jsonError(400, '无法从本机获取 JoyCode 凭据: pt_key is required');
  }

  const client = createJoyClient({
    ptKey,
    userId: body.user_id ?? '',
    baseURL: env.JOYCODE_BASE_URL,
    saasBaseURL: env.JOYCODE_SAAS_BASE_URL,
    clientVersion: env.JOYCODE_CLIENT_VERSION,
  });

  let info: any;
  try {
    info = await client.userInfo();
  } catch (e) {
    return jsonError(
      401,
      '凭据验证失败，请先在 JoyCode IDE 中登录: ' + (e instanceof Error ? e.message : String(e))
    );
  }

  const code = info?.code;
  if (typeof code !== 'number' || code !== 0) {
    const msg = (info && info.msg) || '未知错误';
    return jsonError(401, '凭据已过期或无效: ' + msg);
  }

  // Extract userID + realName from data (handler.go:596-610).
  let userId = body.user_id ?? '';
  let nickname = userId;
  let realName = '';
  const data = info?.data;
  if (data && typeof data === 'object') {
    const id = (data as Record<string, unknown>).userId;
    const name = (data as Record<string, unknown>).realName;
    if (typeof id === 'string' && id !== '') userId = id;
    if (typeof name === 'string' && name !== '') {
      nickname = name;
      realName = name;
    }
  }
  if (!nickname) nickname = userId;

  if (!userId) {
    return jsonError(400, '无法获取用户ID，请先在 JoyCode IDE 中登录');
  }

  // is_default: true iff no account is currently default (handler.go:618-625).
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  const accounts = await store.listAccounts();
  const isDefault = !accounts.some((a) => a.isDefault);

  try {
    await store.addAccount({
      userId,
      ptKey,
      nickname,
      isDefault,
      defaultModel: 'GLM-5.1',
    });
  } catch (e) {
    return jsonError(500, '保存账号失败: ' + (e instanceof Error ? e.message : String(e)));
  }

  return Response.json({
    ok: true,
    user_id: userId,
    nickname,
    real_name: realName,
    is_default: isDefault,
  });
};
