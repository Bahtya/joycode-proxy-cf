// POST /v1/rerank — document rerank proxy.
// Ports pkg/openai/search.go handleRerank (lines 34-59).
//
// Request: { "query": string, "documents": string[], "top_n": number }.
// Response: the upstream rerank result object, verbatim.
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

  let body: { query?: string; documents?: unknown; top_n?: unknown };
  try {
    body = await readJson(request);
  } catch (e) {
    return e instanceof Response ? e : jsonError(400, 'invalid JSON');
  }

  const query = typeof body.query === 'string' ? body.query : '';
  const documents = Array.isArray(body.documents) ? (body.documents as unknown[]) : [];
  if (!query || documents.length === 0) {
    return jsonError(400, 'query and documents are required');
  }
  const topN = typeof body.top_n === 'number' ? body.top_n : 0;

  const client = createJoyClient({
    ptKey: account.ptKey,
    userId: account.userId,
    baseURL: env.JOYCODE_BASE_URL,
    saasBaseURL: env.JOYCODE_SAAS_BASE_URL,
    clientVersion: env.JOYCODE_CLIENT_VERSION,
  });

  // The client contract types documents as string[]; coerce defensively.
  const docs = documents.map((d) => (typeof d === 'string' ? d : String(d)));
  let result: unknown;
  try {
    result = await client.rerank(query, docs, topN);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(500, msg);
  }

  return Response.json(result);
};
