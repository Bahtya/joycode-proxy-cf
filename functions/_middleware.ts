// Root middleware: CORS (Claude Code / Cursor clients), error boundary, and SPA
// fallback. Pages Functions file-routing on this wrangler version rejects the
// `[...slug]` catch-all, so client-side routes (e.g. /dashboard, /accounts/123)
// are handled here: when nothing else matches (404) and the request looks like a
// browser navigation, serve the SPA index.html and let React Router take over.
import type { Env } from '../src/types';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function acceptsHtml(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('text/html');
}

function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

export const onRequest: PagesFunction<Env> = async ({ request, next, env }) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }
  try {
    const res = await next();

    // SPA fallback: a 404 for a browser navigation (no matching asset/function)
    // should serve index.html so client-side routing can render the page.
    if (
      res.status === 404 &&
      request.method === 'GET' &&
      acceptsHtml(request) &&
      env.ASSETS
    ) {
      try {
        const indexRes = await env.ASSETS.fetch(
          new Request(new URL('/index.html', new URL(request.url)), {
            method: 'GET',
            headers: request.headers,
          })
        );
        if (indexRes.ok) {
          return withCors(new Response(indexRes.body, { status: 200, headers: indexRes.headers }));
        }
      } catch {
        /* fall through to the 404 */
      }
    }
    return withCors(res);
  } catch (err) {
    return Response.json(
      { type: 'error', error: { type: 'internal_error', message: err instanceof Error ? err.message : String(err) } },
      { status: 500, headers: CORS_HEADERS }
    );
  }
};
