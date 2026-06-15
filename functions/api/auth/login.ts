// POST /api/auth/login — port of handleAuthLogin (handler.go:339-380).
//
// Verifies the dashboard password and returns a fresh JWT. Go does NOT set a
// cookie on login (only the OAuth callback does); we additionally set an
// httpOnly `joycode_token` cookie so the SPA can read session state from
// document.cookie — see deviation note. The cookie and the returned `token`
// carry the same JWT.

import type { Env } from '../../../src/types';
import { SettingKeys } from '../../../src/types';
import { getSetting, setSetting } from '../../../src/store/settings';
import { comparePassword } from '../../../src/auth/password';
import { signJWT, resolveJwtSecret } from '../../../src/auth/jwt';
import { hexId } from '../../../src/util/id';
import { readJson } from '../../../src/util/http';

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

// Cookie lifetime. Go's login JWT uses defaultJWTExpiry (24h); the OAuth
// callback uses 7d. The task spec allows either; we use 24h to match the login
// token's own expiry so the cookie and the body token expire together.
const COOKIE_MAX_AGE = 24 * 60 * 60;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const hash = await getSetting(env.DB, SettingKeys.authPasswordHash);
  // handler.go:351-354 — not yet initialized.
  if (!hash) {
    return Response.json({ detail: 'root password not initialized' }, { status: 409 });
  }

  const body = await readJson<LoginBody>(request);
  const password = typeof body.password === 'string' ? body.password : '';
  // username is accepted but ignored — Go only ever issues "root" tokens.

  if (!(await comparePassword(password, hash))) {
    return Response.json({ detail: '密码错误' }, { status: 401 });
  }

  // Ensure a JWT secret exists before signing. Setup normally creates one, but
  // if AUTH_PASSWORD_HASH was pre-seeded via secret without a JWT secret, we
  // generate one here (mirrors setup.ts).
  let secret = await resolveJwtSecret(env);
  if (!secret) {
    secret = hexId(32);
    await setSetting(env.DB, SettingKeys.authJwtSecret, secret);
  }

  const token = await signJWT('root', secret);

  // Set httpOnly cookie for the SPA. SameSite=Lax + Secure (Workers are HTTPS
  // only). Not HttpOnly=false like the OAuth `joycode_auto_jwt` cookie, since
  // this is the durable dashboard session.
  const res = Response.json({ ok: true, token });
  res.headers.append(
    'Set-Cookie',
    `joycode_token=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax; Secure`
  );
  return res;
};
