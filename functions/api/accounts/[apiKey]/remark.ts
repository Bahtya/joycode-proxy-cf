// PUT|POST /api/accounts/<userId>/remark  { remark }
import type { Env } from '../../../../src/types';
import { createStore } from '../../../../src/store/d1';
import { readJson } from '../../../../src/util/http';
import { userIdParam } from '../../../../src/dashboard/account-views';

const handle: PagesFunction<Env> = async ({ request, env, params }) => {
  const userId = userIdParam(params);
  const body = await readJson<{ remark?: string }>(request);
  const remark = body.remark ?? '';
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  await store.updateRemark(userId, remark);
  return Response.json({ ok: true, user_id: userId, remark });
};
export const onRequestPut = handle;
export const onRequestPost = handle;
