// GET /api/oauth-callback?pt_key= — port of handleOAuthCallback (handler.go:823-856).
//
// Landing target after JD/JoyCode browser auth. Validates the pt_key, saves the
// account (validateAndSave), then auto-issues a JWT so the dashboard is
// immediately usable and 302-redirects to "/". On failure, redirects to
// "/?login_error=<msg>".
//
// Whitelisted in functions/api/_middleware.ts (no JWT required) — it is the
// entry point that ESTABLISHES the session.

import type { Env } from '../../src/types';
import { validateAndSave } from '../../src/qr/jdlogin';
import { createStore } from '../../src/store/d1';
import { signJWT, resolveJwtSecret } from '../../src/auth/jwt';

// OAuth callback JWT lives 7 days (handler.go:843), matching the Go cookie MaxAge.
const OAUTH_JWT_EXPIRY = 7 * 24 * 60 * 60;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const ptKey = url.searchParams.get('pt_key') ?? '';

  let userId: string;
  let nickname: string;
  try {
    // is_default = true iff no account is currently default (handler.go:806-813).
    const store = createStore(env.DB, env.PTKEY_ENC_KEY);
    const accounts = await store.listAccounts();
    const makeDefault = !accounts.some((a) => a.isDefault);
    const r = await validateAndSave(env, ptKey, makeDefault);
    userId = r.userId;
    nickname = r.nickname;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.redirect(new URL('/?login_error=' + encodeURIComponent(msg), request.url).toString(), 302);
  }

  // Auto-issue JWT so the SPA dashboard is immediately accessible (handler.go:841-853).
  const secret = await resolveJwtSecret(env);
  if (secret) {
    const token = await signJWT(userId, secret, OAUTH_JWT_EXPIRY).catch(() => null);
    if (token) {
      const target = new URL('/?login_success=' + encodeURIComponent(userId), request.url).toString();
      // Same cookie name + attributes as Go's joycode_auto_jwt (handler.go:844-851):
      // HttpOnly omitted (HttpOnly:false), SameSite=Lax, short Max-Age so the SPA
      // reads it once then re-issues a durable session via /api/auth/login.
      const res = Response.redirect(target, 302);
      res.headers.append(
        'Set-Cookie',
        `joycode_auto_jwt=${token}; Path=/; Max-Age=30; SameSite=Lax; Secure`
      );
      // Suppress unused-warning while keeping the value available for diagnostics.
      void nickname;
      return res;
    }
  }

  return Response.redirect(new URL('/?login_success=' + encodeURIComponent(userId), request.url).toString(), 302);
};
