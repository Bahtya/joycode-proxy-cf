// GET /api/accounts/<userId>/logs
import type { Env } from '../../../../src/types';
import { accountLogsResponse, userIdParam } from '../../../../src/dashboard/account-views';

export const onRequestGet: PagesFunction<Env> = async ({ request, env, params }) =>
  accountLogsResponse(env, new URL(request.url), userIdParam(params));
