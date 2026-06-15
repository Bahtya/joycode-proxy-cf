// GET /api/errors — recent error logs.
// Ports pkg/dashboard/handler.go handleErrors + store.GetRecentErrors.
// Query: ?limit=<1..200> (default 50, clamped like Go).
// Response shape (web/src/api.ts getRecentErrors): { errors: RequestLog[], total: number }.
import type { Env } from '../../src/types';
import { getErrorStats } from '../../src/store/dashboard';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const limitRaw = url.searchParams.get('limit');
  let limit = 50;
  if (limitRaw) {
    const n = parseInt(limitRaw, 10);
    if (Number.isFinite(n) && n > 0 && n <= 200) limit = n;
  }

  const { recent, total } = await getErrorStats(env.DB, limit);
  return Response.json({ errors: recent, total });
};
