// Header builders for JoyCode upstream requests.
// Ported from pkg/joycode/client.go: headers() (lines 93-104).
//
// In the Go client these returned an http.Header (map[string][]string); here we
// return a plain Record<string,string> which is the shape fetch() HeadersInit
// accepts. Header keys are case-insensitive in Workers, but we keep the exact
// casing from Go for traceability.

/** JoyCode desktop client version. See pkg/joycode/client.go:20. */
export const CLIENT_VERSION = '2.4.5';

/**
 * The Electron User-Agent the JoyCode desktop client sends.
 * Hardcoded upstream expectation; do not change. See pkg/joycode/client.go:21-23.
 */
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'JoyCode/2.4.5 Chrome/133.0.0.0 Electron/35.2.0 Safari/537.36';

/**
 * Headers for the standard (OpenAI-style) JoyCode upstream path.
 * See pkg/joycode/client.go:93-104 (headers()).
 *
 * NOTE: Accept-Encoding lists "gzip, deflate, br" to match Go, but Workers
 * fetch() auto-decompresses transparently — callers never handle gzip.
 */
export function openaiHeaders(ptKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json; charset=UTF-8',
    ptKey,
    loginType: 'N_PIN_PC',
    'User-Agent': USER_AGENT,
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Connection: 'keep-alive',
  };
}
