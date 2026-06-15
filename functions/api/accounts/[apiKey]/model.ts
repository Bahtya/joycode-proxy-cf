// PUT|POST /api/accounts/<userId>/model  { default_model }
import type { Env } from '../../../../src/types';
import { createStore } from '../../../../src/store/d1';
import { readJson } from '../../../../src/util/http';
import { userIdParam } from '../../../../src/dashboard/account-views';

const handle: PagesFunction<Env> = async ({ request, env, params }) => {
  const userId = userIdParam(params);
  const body = await readJson<{ default_model?: string }>(request);
  const model = body.default_model ?? '';
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  await store.setDefaultModel(userId, model);
  return Response.json({ ok: true, api_key: userId, default_model: model });
};
export const onRequestPut = handle;
export const onRequestPost = handle;
