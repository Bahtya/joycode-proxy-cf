// POST /api/accounts/<userId>/validate
import type { Env } from '../../../../src/types';
import { createStore } from '../../../../src/store/d1';
import { notFound } from '../../../../src/util/http';
import { clientFor, userIdParam } from '../../../../src/dashboard/account-views';

export const onRequestPost: PagesFunction<Env> = async ({ env, params }) => {
  const userId = userIdParam(params);
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  const account = await store.getAccount(userId);
  if (!account) return notFound('account not found');
  let valid = true;
  try {
    await clientFor(env, account).validate();
    await store.setCredentialValid(userId, 1);
  } catch {
    valid = false;
    await store.setCredentialValid(userId, 0);
  }
  return Response.json({ api_key: userId, valid });
};
