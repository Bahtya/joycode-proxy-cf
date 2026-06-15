// GET /api/health — dashboard health probe.
// Ports pkg/dashboard/handler.go handleHealth: returns { status:'ok', accounts:<count> }.
// Enriched with a DB reachability flag and keepalive statuses (serverless has no
// in-process keeper map, so we surface the keepalive_status table instead).
import type { Env } from '../../src/types';
import { createStore } from '../../src/store/d1';

const VERSION = '0.3.0'; // mirrors the version string in Go handleHealth

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);

  let db = 'ok';
  let accounts = 0;
  let keepalive: unknown[] = [];
  try {
    accounts = await store.countAccounts();
    keepalive = await store.listKeepaliveStatus();
  } catch (e) {
    db = e instanceof Error ? e.message : 'db error';
  }

  return Response.json({
    status: 'ok',
    db,
    accounts,
    version: VERSION,
    keepalive,
  });
};
