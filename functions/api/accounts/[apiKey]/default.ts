// PUT|POST /api/accounts/<userId>/default
import type { Env } from '../../../../src/types';
import { createStore } from '../../../../src/store/d1';
import { userIdParam } from '../../../../src/dashboard/account-views';

const handle: PagesFunction<Env> = async ({ env, params }) => {
  const userId = userIdParam(params);
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  await store.setDefault(userId);
  return Response.json({ ok: true });
};
export const onRequestPut = handle;
export const onRequestPost = handle;
