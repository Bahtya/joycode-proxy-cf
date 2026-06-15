// /api/accounts/<userId> — account detail (GET) + delete (DELETE).
// (Sub-actions live in sibling files under [apiKey]/ — Pages routes each segment.)
import type { Env } from '../../../../src/types';
import { createStore } from '../../../../src/store/d1';
import { notFound } from '../../../../src/util/http';
import { userIdParam } from '../../../../src/dashboard/account-views';

export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  const userId = userIdParam(params);
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  const account = await store.getAccount(userId);
  if (!account) return notFound('account not found');
  return Response.json({ account });
};

export const onRequestDelete: PagesFunction<Env> = async ({ env, params }) => {
  const userId = userIdParam(params);
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  await store.deleteAccount(userId);
  return Response.json({ ok: true });
};
