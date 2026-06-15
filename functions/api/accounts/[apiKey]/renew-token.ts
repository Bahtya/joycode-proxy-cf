// POST /api/accounts/<userId>/renew-token — refresh the upstream pt_key if rotated.
import type { Env } from '../../../../src/types';
import { createStore } from '../../../../src/store/d1';
import { jsonError, notFound } from '../../../../src/util/http';
import { clientFor, userIdParam } from '../../../../src/dashboard/account-views';

export const onRequestPost: PagesFunction<Env> = async ({ env, params }) => {
  const userId = userIdParam(params);
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  const account = await store.getAccount(userId);
  if (!account) return notFound('account not found');
  let newPtKey = '';
  try {
    newPtKey = await clientFor(env, account).userInfoWithRefresh();
  } catch (e) {
    return jsonError(500, e instanceof Error ? e.message : String(e));
  }
  if (newPtKey && newPtKey !== account.ptKey) {
    await store.updatePtKey(userId, newPtKey);
    await store.setCredentialValid(userId, 1);
    await store.updateCredentialRefreshedAt(userId);
  }
  return Response.json({ ok: true, refreshed: !!newPtKey });
};
