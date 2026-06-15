// POST /api/auth/change-password — port of handleChangePassword (handler.go:382-432).
//
// JWT-gated by the /api/* middleware (this path is not whitelisted). Verifies
// the old password, enforces the 6-char minimum on the new one, and stores the
// new bcrypt hash. Does NOT rotate the JWT secret or reissue a token — the
// caller's existing token remains valid until it expires, matching Go.

import type { Env } from '../../../src/types';
import { SettingKeys } from '../../../src/types';
import { getSetting, setSetting } from '../../../src/store/settings';
import { hashPassword, comparePassword } from '../../../src/auth/password';
import { readJson } from '../../../src/util/http';

interface ChangePasswordBody {
  old_password?: unknown;
  new_password?: unknown;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const hash = await getSetting(env.DB, SettingKeys.authPasswordHash);
  // handler.go:393-396 — not yet initialized.
  if (!hash) {
    return Response.json({ detail: 'root password not initialized' }, { status: 409 });
  }

  const body = await readJson<ChangePasswordBody>(request);
  const oldPassword = typeof body.old_password === 'string' ? body.old_password : '';
  const newPassword = typeof body.new_password === 'string' ? body.new_password : '';

  // handler.go:407-410 — old password must match.
  if (!(await comparePassword(oldPassword, hash))) {
    return Response.json({ detail: '原密码错误' }, { status: 401 });
  }

  // handler.go:412-415 — new password min length.
  if (newPassword.length < 6) {
    return Response.json({ detail: '新密码长度不能少于 6 位' }, { status: 400 });
  }

  const newHash = await hashPassword(newPassword);
  await setSetting(env.DB, SettingKeys.authPasswordHash, newHash);

  return Response.json({ ok: true });
};
