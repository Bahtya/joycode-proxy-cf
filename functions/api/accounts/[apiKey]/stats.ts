// GET /api/accounts/<userId>/stats
import type { Env } from '../../../../src/types';
import { accountStatsResponse, userIdParam } from '../../../../src/dashboard/account-views';
import { getIntSetting } from '../../../../src/store/settings';

export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  const off = await getIntSetting(env.DB, 'tz_offset', 8);
  return accountStatsResponse(env, userIdParam(params), off);
};
