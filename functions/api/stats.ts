// GET /api/stats — global dashboard stats.
// Ports pkg/dashboard/handler.go handleStats + store.GetStats/GetAllTimeTotals/GetHourlyStats.
// Response shape must match web/src/api.ts Stats interface.
import type { Env } from '../../src/types';
import { getStats } from '../../src/store/dashboard';
import { getIntSetting } from '../../src/store/settings';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id') ?? url.searchParams.get('userId') ?? undefined;
  const daysRaw = url.searchParams.get('days');
  const days = daysRaw && Number.isFinite(parseInt(daysRaw, 10)) ? parseInt(daysRaw, 10) : undefined;

  const off = await getIntSetting(env.DB, 'tz_offset', 8);
  const stats = await getStats(env.DB, { userId, days }, off);
  return Response.json(stats);
};
