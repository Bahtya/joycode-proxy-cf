// GET /api/accounts/<userId>/stats
import type { Env } from '../../../../src/types';
import { accountStatsResponse, userIdParam } from '../../../../src/dashboard/account-views';

export const onRequestGet: PagesFunction<Env> = async ({ env, params }) =>
  accountStatsResponse(env, userIdParam(params));
