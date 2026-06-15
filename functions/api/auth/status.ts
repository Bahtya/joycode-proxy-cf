// GET /api/auth/status — port of handleAuthStatus (handler.go:262-278).
//
// Returns whether the dashboard password has been initialized. Go returns
// { initialized, exe_path }; exe_path has no meaning on Workers, so we return
// `initialized` (Go-faithful) plus `configured` (the boolean the SPA task spec
// expects) for convenience.

import type { Env } from '../../../src/types';
import { SettingKeys } from '../../../src/types';
import { getSetting } from '../../../src/store/settings';

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const hash = await getSetting(env.DB, SettingKeys.authPasswordHash);
  const initialized = !!hash;
  return Response.json({
    initialized, // Go-faithful field name
    configured: initialized, // convenience alias expected by the SPA
  });
};
