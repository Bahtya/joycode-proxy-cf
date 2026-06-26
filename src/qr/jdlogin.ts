// ptKey validation + account persistence — shared by the JDH login flow
// (src/qr/jdhlogin.ts, the current jdhgpt.jd.com pollLoginInfo flow) and the
// manual paste path (functions/api/oauth-submit.ts).
//
// HISTORY: this module previously ported pkg/auth/jdlogin.go's passport.jd.com
// QR login (appid=133: qrInit/qrPoll/validateAndFetchInfo via
// qr.m.jd.com + passport.jd.com/uc/qrCodeTicketValidation). JD deprecated that
// flow — ticket validation now returns `returnCode=80` — so it has been removed.
// The working login now lives in ./jdhlogin.ts. Only the ptKey → userInfo →
// upsert-save step (which is provider-agnostic) remains here.

import type { Env } from '../types';
import { createJoyClient } from '../joycode/client';
import { Store } from '../store/d1';

export interface ValidateAndSaveResult {
  userId: string;
  nickname: string;
}

/**
 * Validate a pt_key and save the resulting account. Mirrors
 * handler.go:validateAndSavePtKey (773-821) plus MAX_ACCOUNTS enforcement.
 *
 * store.addAccount upserts on user_id (PRIMARY KEY), so a re-login of an
 * existing (e.g. expired) account refreshes its pt_key in place instead of
 * failing — nickname/api_token/default_model/is_default/display_order are
 * preserved, credential_valid is reset to 1.
 *
 * @param env         Worker env.
 * @param ptKey       the JD pt_key to validate.
 * @param makeDefault whether to mark the (new) account default. For a re-login
 *                    of an existing account this is ignored by the upsert.
 */
export async function validateAndSave(
  env: Env,
  ptKey: string,
  makeDefault: boolean,
): Promise<ValidateAndSaveResult> {
  if (!ptKey) {
    throw new Error('missing pt_key');
  }

  const client = createJoyClient({
    ptKey,
    userId: '',
    baseURL: env.JOYCODE_BASE_URL,
    clientVersion: env.JOYCODE_CLIENT_VERSION,
  });

  let info: any;
  try {
    info = await client.userInfo();
  } catch (e) {
    throw new Error('userInfo validation failed: ' + (e instanceof Error ? e.message : String(e)));
  }

  const code = info?.code;
  if (typeof code !== 'number' || code !== 0) {
    const msg = (info && typeof info.msg === 'string' && info.msg) || 'unknown error';
    throw new Error(`userInfo API error (code=${code}): ${msg}`);
  }

  let userId = '';
  let nickname = '';
  const data = info?.data;
  if (data && typeof data === 'object') {
    const id = (data as Record<string, unknown>).userId;
    const name = (data as Record<string, unknown>).realName;
    if (typeof id === 'string' && id !== '') userId = id;
    if (typeof name === 'string' && name !== '') nickname = name;
  }
  if (!nickname) nickname = userId;
  if (!userId) {
    throw new Error('无法获取用户ID，请重新授权');
  }

  // Enforce MAX_ACCOUNTS before the insert (the Go store enforces a cap too;
  // we check here so the error message is actionable for the OAuth flows).
  const maxAccounts = parseInt(env.MAX_ACCOUNTS ?? '10', 10);
  const store = new Store(env.DB, env.PTKEY_ENC_KEY);
  if (Number.isFinite(maxAccounts) && maxAccounts > 0) {
    const count = await store.countAccounts();
    // Allow the save if this account already exists (refresh) or we're under cap.
    const existing = await store.getAccount(userId);
    if (!existing && count >= maxAccounts) {
      throw new Error(`已达到最大账号数限制 (${maxAccounts})`);
    }
  }

  await store.addAccount({
    userId,
    ptKey,
    nickname,
    isDefault: makeDefault,
    defaultModel: 'GLM-5.1',
  });

  return { userId, nickname };
}
