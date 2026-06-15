// POST /api/browser-login — port of handleBrowserLogin (handler.go:731-769).
//
// Returns the JoyCode browser-login URL the user opens to authorize. On the
// edge there is no local port for JoyCode to call back to (the desktop IDE's
// authPort/authKey mechanism), so authPort/authKey are cosmetic: the real
// completion path is the user pasting pt_key into /api/oauth-submit, or JD
// redirecting to /api/oauth-callback?pt_key=. We still emit both fields to
// keep the URL shape identical to the Go handler.
//
// Whitelisted in functions/api/_middleware.ts (no JWT required).

import type { Env } from '../../src/types';
import { hexId } from '../../src/util/id';

export const onRequestPost: PagesFunction<Env> = async () => {
  const token = hexId(16); // Go: crypto/rand 16 bytes → 32 hex (handler.go:750-755).
  const loginURL =
    'https://joycode.jd.com/login/?ideAppName=JoyCode&fromIde=ide&redirect=0' +
    `&authPort=${encodeURIComponent('34891')}` + // cosmetic on edge; Go derives from Host header.
    `&authKey=${encodeURIComponent(token)}`;

  return Response.json({ ok: true, url: loginURL, token });
};
