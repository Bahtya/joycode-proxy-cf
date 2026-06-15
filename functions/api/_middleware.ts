// /api/* auth gate — port of pkg/auth/middleware.go (JWTMiddleware).
//
// In Pages Functions, a _middleware.ts placed in functions/api/ wraps the entire
// /api/* subtree, so the Go `strings.HasPrefix(path, "/api/")` check is implied
// by location. Everything else mirrors the Go middleware:
//
//   1. OPTIONS is always allowed (also handled by the root CORS middleware, but
//      we short-circuit before any DB/JWT work to match Go line 27-30).
//   2. Whitelisted paths pass through without a JWT (Go middleware.go:32-45).
//   3. If no password hash is configured yet (auth disabled / open setup), the
//      request passes through (Go middleware.go:47-51).
//   4. Otherwise a valid JWT is required. Go reads ONLY the Authorization
//      Bearer header; we additionally accept the `joycode_token` / `token`
//      cookie so the SPA dashboard can authenticate via cookie (see deviation
//      note below).
//   5. On success, the decoded username is attached to `data.user` for
//      downstream handlers (the Go equivalent sets a context value consumed by
//      auth.AuthenticatedUser).

import type { Env } from '../../src/types';
import { SettingKeys } from '../../src/types';
import { getSetting } from '../../src/store/settings';
import { verifyJWT, resolveJwtSecret } from '../../src/auth/jwt';
import { getBearerToken, cookieValue } from '../../src/util/http';

// Whitelist (middleware.go:32-41).
const WHITELIST = new Set<string>([
  '/api/auth/status',
  '/api/auth/setup',
  '/api/auth/login',
  '/api/health',
  '/api/browser-login',
  '/api/oauth-callback',
  '/api/oauth-submit',
  '/api/qr-login/init',
]);

// Cookie names accepted as a JWT source. The SPA login flow sets
// `joycode_token` (see functions/api/auth/login.ts); `token` is accepted as a
// convenient alias.
const COOKIE_NAMES = ['joycode_token', 'token'];

export const onRequest: PagesFunction<Env> = async ({ request, env, data, next }) => {
  const url = new URL(request.url);
  const path = url.pathname;

  // (1) CORS preflight — always allow.
  if (request.method === 'OPTIONS') {
    return next();
  }

  // (2) Whitelisted paths — no JWT required.
  if (WHITELIST.has(path)) {
    return next();
  }

  // (3) Auth disabled until a password hash exists (open-setup window).
  const hash = await getSetting(env.DB, SettingKeys.authPasswordHash);
  if (!hash) {
    return next();
  }

  // (4) Extract token: Bearer header first, then cookie fallback.
  let token = getBearerToken(request);
  if (!token) {
    const cookieHeader = request.headers.get('cookie');
    if (cookieHeader) {
      for (const name of COOKIE_NAMES) {
        const v = cookieValue(cookieHeader, name);
        if (v) {
          token = v;
          break;
        }
      }
    }
  }

  if (!token) {
    // Matches Go: "missing authorization header" / "invalid authorization
    // format". The SPA-side reads `detail`.
    return Response.json({ detail: 'missing authorization token' }, { status: 401 });
  }

  const secret = await resolveJwtSecret(env);
  if (!secret) {
    // middleware.go:66-69 — JWT secret not configured → 500-class config error.
    return Response.json({ detail: 'server configuration error' }, { status: 500 });
  }

  const payload = await verifyJWT(token, secret);
  if (!payload) {
    return Response.json({ detail: 'invalid or expired token' }, { status: 401 });
  }

  // (5) Attach username for downstream handlers (cf. AuthenticatedUser).
  (data as Record<string, unknown>).user = payload.username;

  return next();
};
