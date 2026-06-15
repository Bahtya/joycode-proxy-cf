// v1 subtree middleware: resolve the JoyCode account for every /v1/* request.
//
// Ports the per-request client resolution that the Go server wired via
// srv.Resolver (cmd/JoyCodeProxy/serve.go:125-171, 172) plus the account
// selection in requestLogMiddleware (serve.go:324-347). Here it runs once per
// request as a Pages Function _middleware and stashes the resolved Account on
// the shared `data` object so downstream handlers (chat/completions, models,
// web-search, rerank, messages) can read `data.account`.
//
// The Anthropic /v1/messages route lives in this same subtree; it shares this
// resolver, so its handler must also tolerate `data.account` being set here.
import type { Env } from '../../src/types';
import type { Account } from '../../src/types';
import { resolveAccount } from '../../src/proxy/resolve';

/**
 * Shared data bag populated by this middleware for /v1/* handlers.
 * Declared with an index signature so it satisfies PagesFunction's
 * `Data extends Record<string, unknown>` constraint.
 */
export type V1Data = {
  account?: Account;
  [k: string]: unknown;
};

/**
 * Error-shape choice for the "no account" case:
 *   - An API key WAS supplied but matched nothing  -> 403 (invalid api key)
 *   - No key AND no default account configured      -> 503 (no account configured)
 *
 * The Go server returned the systemClient (or nil → 404-ish) in this situation;
 * serverless has no system client, so we fail explicitly with a JSON error.
 */
export const onRequest: PagesFunction<Env, string, V1Data> = async ({ request, env, data, next }) => {
  const account = await resolveAccount(request, env);

  if (!account) {
    // Distinguish "bad key" from "nothing configured".
    const hasKey = Boolean(
      request.headers.get('x-api-key') ||
        (request.headers.get('authorization') ?? '').toLowerCase().startsWith('bearer ')
    );
    if (hasKey) {
      return Response.json(
        { type: 'error', error: { type: 'authentication_error', message: 'invalid api key' } },
        { status: 403 }
      );
    }
    return Response.json(
      { type: 'error', error: { type: 'invalid_request_error', message: 'no account configured' } },
      { status: 503 }
    );
  }

  // Pages Functions: `data` is the shared bag threaded through the subtree.
  data.account = account;
  return next();
};
