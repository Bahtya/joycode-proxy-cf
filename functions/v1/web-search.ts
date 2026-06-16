// POST /v1/web-search — web search proxy.
// Ports pkg/openai/search.go handleWebSearch (lines 9-32).
//
// Request: { "query": string }. Response: { "search_result": [...] }.
// The client used to POST is resolved from data.account by the _middleware.
import type { Env } from '../../src/types';
import type { V1Data } from './_middleware';
import { readJson, jsonError } from '../../src/util/http';
import { createJoyClient } from '../../src/joycode/client';

export const onRequestPost: PagesFunction<Env, string, V1Data> = async ({ request, env, data }) => {
  const account = data.account;
  if (!account) {
    return jsonError(503, 'no account configured');
  }

  let body: { query?: string };
  try {
    body = await readJson<{ query?: string }>(request);
  } catch (e) {
    return e instanceof Response ? e : jsonError(400, 'invalid JSON');
  }

  const query = typeof body.query === 'string' ? body.query : '';
  if (!query) {
    return jsonError(400, 'query is required');
  }

  const client = createJoyClient({
    ptKey: account.ptKey,
    userId: account.userId,
    baseURL: env.JOYCODE_BASE_URL,
    clientVersion: env.JOYCODE_CLIENT_VERSION,
  });

  let results: unknown[];
  try {
    results = await client.webSearch(query);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(500, msg);
  }

  return Response.json({ search_result: results });
};
