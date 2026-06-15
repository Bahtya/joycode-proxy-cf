// GET /api/accounts/<userId>/models
import type { Env } from '../../../../src/types';
import { createStore } from '../../../../src/store/d1';
import { notFound } from '../../../../src/util/http';
import { clientFor, FALLBACK_MODELS, userIdParam } from '../../../../src/dashboard/account-views';

export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  const userId = userIdParam(params);
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  const account = await store.getAccount(userId);
  if (!account) return notFound('account not found');
  try {
    const models = await clientFor(env, account).listModels();
    return Response.json({ models });
  } catch {
    return Response.json({ models: FALLBACK_MODELS.map((m) => ({ id: m, name: m })) });
  }
};
