// POST /api/auth/setup — port of handleAuthSetup (handler.go:280-337).
//
// One-time dashboard password setup. Allowed only before a password hash
// exists. On success it auto-generates a JWT secret (if neither env.JWT_SECRET
// nor the `auth_jwt_secret` setting is configured) and immediately issues a
// session token so the caller is logged in.

import type { Env } from '../../../src/types';
import { SettingKeys } from '../../../src/types';
import { getSetting, setSetting } from '../../../src/store/settings';
import { hashPassword } from '../../../src/auth/password';
import { signJWT, resolveJwtSecret } from '../../../src/auth/jwt';
import { hexId } from '../../../src/util/id';
import { readJson } from '../../../src/util/http';

interface SetupBody {
  password?: unknown;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // Already initialized → reject. Go returns 409 Conflict here (handler.go:291);
  // we keep that status for fidelity.
  const existing = await getSetting(env.DB, SettingKeys.authPasswordHash);
  if (existing) {
    return Response.json({ detail: 'root password already initialized' }, { status: 409 });
  }

  const body = await readJson<SetupBody>(request);
  const password = typeof body.password === 'string' ? body.password : '';
  // handler.go:302 — min 6 chars.
  if (password.length < 6) {
    return Response.json({ detail: '密码长度不能少于 6 位' }, { status: 400 });
  }

  const hash = await hashPassword(password);
  await setSetting(env.DB, SettingKeys.authPasswordHash, hash);

  // handler.go:320-323 — auto-gen a JWT secret when none is configured.
  let secret = await resolveJwtSecret(env);
  if (!secret) {
    secret = hexId(32); // generateRandomHex(32) in Go (handler.go:442-446)
    await setSetting(env.DB, SettingKeys.authJwtSecret, secret);
  }

  // handler.go:434-440 — issueJWT signs for "root" with default 24h expiry.
  const token = await signJWT('root', secret);

  return Response.json({ ok: true, token });
};
