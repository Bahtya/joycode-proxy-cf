// POST /api/qr-login/init — start a JDH (jdhgpt.jd.com) login session.
//
// Returns { ok, session_id, url } where `url` is the JoyCode pluginlogin page
// carrying a one-time uuid. The SPA renders `url` as a QR (scan with the JD app)
// or as a clickable link, then polls /api/qr-login/status until the browser
// login completes and a ptKey is captured server-side.
//
// Whitelisted in functions/api/_middleware.ts (no JWT required) so an
// unauthenticated user can begin the login flow.

import type { Env } from '../../../src/types';
import { loginInit } from '../../../src/qr/jdhlogin';
import { jsonError } from '../../../src/util/http';

export const onRequestPost: PagesFunction<Env> = async ({ env }) => {
  try {
    const { sessionId, url } = await loginInit(env);
    return Response.json({ ok: true, session_id: sessionId, url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonError(500, '生成登录会话失败: ' + msg);
  }
};
