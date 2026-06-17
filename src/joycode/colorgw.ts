// JoyCode "color gateway" client (api-ai.jd.com) — HMAC-SHA256 signed URLs.
//
// JoyCode IDE 2.7.5 (2026-06-17) migrated ALL authenticated endpoints off the
// legacy joycode-api.jd.com to api-ai.jd.com with signed URLs; the legacy host
// now returns empty 200s. This module mirrors the signing scheme used by the
// reference cpa-plugin-joycode client.
//
// signedColorUrl: params {appid, functionId, t} sorted by key, their VALUES
// joined with "&", HMAC-SHA256(secret) hex. The body is the clean OpenAI
// payload (no tenant/userId/client envelope); auth is via ptKey + loginType
// headers.

const COLOR_PATH = '/api';
const COLOR_APPID = 'joycode_ide';
const COLOR_SECRET = '0691a3f0b37b4a85aeb63ad0fc7db3ed';

/** Default loginType for the color gateway (was N_PIN_PC on the legacy host). */
export const COLOR_LOGIN_TYPE = 'PIN_JD_CLOUD';
/** Upstream expects the bare "node" UA now (not the legacy Electron UA). */
export const COLOR_USER_AGENT = 'node';

/** Color-gateway function IDs. */
export const FN_CHAT = 'chat_completions';
export const FN_USER_INFO = 'joycode_userInfo';
export const FN_MODEL_LIST = 'joycode_modelList';

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Build a signed color-gateway URL for `functionId` (HMAC-SHA256, WebCrypto). */
export async function signedColorUrl(baseURL: string, functionId: string): Promise<string> {
  const t = Date.now();
  // params sorted by key: appid, functionId, t — join their VALUES with "&".
  const signStr = [COLOR_APPID, functionId, String(t)].join('&');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(COLOR_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sign = toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signStr)));
  return `${baseURL}${COLOR_PATH}?appid=${COLOR_APPID}&functionId=${functionId}&t=${t}&sign=${sign}`;
}

/** Headers for a color-gateway request (ptKey auth + PIN_JD_CLOUD login type). */
export function colorHeaders(ptKey: string, tenant?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json; charset=UTF-8',
    ptKey,
    loginType: COLOR_LOGIN_TYPE,
    'User-Agent': COLOR_USER_AGENT,
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': '*',
    Connection: 'keep-alive',
  };
  if (tenant) h['tenant'] = tenant;
  return h;
}
