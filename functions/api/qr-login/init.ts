// POST /api/qr-login/init — port of handleQRLoginInit (handler.go:891-914).
//
// Starts a JD QR-scan login session. Returns { ok, session_id, qr_image } where
// qr_image is a "data:image/png;base64,...." URL the SPA renders directly.
//
// Whitelisted in functions/api/_middleware.ts (no JWT required) so an
// unauthenticated user can begin the login flow.

import type { Env } from '../../../src/types';
import { qrInit } from '../../../src/qr/jdlogin';
import { jsonError } from '../../../src/util/http';

export const onRequestPost: PagesFunction<Env> = async ({ env }) => {
  try {
    const { sessionId, qrImage } = await qrInit(env);
    return Response.json({ ok: true, session_id: sessionId, qr_image: qrImage });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonError(500, '生成二维码失败: ' + msg);
  }
};
