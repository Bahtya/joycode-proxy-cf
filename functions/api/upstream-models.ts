// GET /api/upstream-models — live upstream model candidates for the Settings
// "selectable models" editor. Fetches JoyCode's modelList using the DEFAULT
// account's pt_key and maps joycode ModelInfo (modelId/label) → {id,name}.
// Returns { models: [] } when there is no default account or the upstream call
// fails, so the editor degrades gracefully (still showing the persistent
// Claude-Opus-4.7 virtual model).
import type { Env } from '../../src/types';
import { createStore } from '../../src/store/d1';
import { clientFor } from '../../src/dashboard/account-views';

interface DashboardModel {
  id: string;
  name: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  const account = await store.getDefaultAccount();
  if (!account) return Response.json({ models: [] });
  try {
    const list = await clientFor(env, account).listModels();
    const models: DashboardModel[] = list
      .map((m) => ({ id: m.modelId, name: m.label || m.modelId }))
      .filter((m) => m.id !== '');
    return Response.json({ models });
  } catch {
    return Response.json({ models: [] });
  }
};
