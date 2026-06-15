// GET /api/models — list available models.
// Ports pkg/dashboard/handler.go handleModels.
//
// Go handleModels ALWAYS returns the hardcoded joycode.Models list as {id,name}
// pairs (it never calls the upstream for /api/models). We match that exactly.
// (The per-account live model fetch is a separate endpoint, /api/accounts/:id/models,
//  not part of this module.)
// Response shape (frontend web/src/api.ts listModels): { models: { id, name }[] }.
import type { Env } from '../../src/types';
import { MODELS } from '../../src/joycode/models';

interface DashboardModel {
  id: string;
  name: string;
}

export const onRequestGet: PagesFunction<Env> = async () => {
  const models: DashboardModel[] = MODELS.map((m) => ({ id: m, name: m }));
  return Response.json({ models });
};
