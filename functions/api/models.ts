// GET /api/models — the admin-configured selectable model list
// (settings.selectable_models, falling back to DEFAULT_SELECTABLE_MODELS).
//
// This is the single source for all dashboard model dropdowns. It is a DISPLAY
// concern only — the request-routing allowlist (resolveModel) still uses the
// static MODELS catalog and is intentionally NOT coupled to this setting.
// Companion endpoint: GET /api/upstream-models returns the raw live JoyCode
// candidates that the Settings editor picks from.
// Response shape (frontend web/src/api.ts listModels): { models: { id, name }[] }.
import type { Env } from '../../src/types';
import { getModelList } from '../../src/store/settings';

interface DashboardModel {
  id: string;
  name: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const ids = await getModelList(env.DB);
  const models: DashboardModel[] = ids.map((id) => ({ id, name: id }));
  return Response.json({ models });
};
