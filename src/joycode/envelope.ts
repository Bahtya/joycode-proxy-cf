// Request body builders ("envelopes") for JoyCode upstream calls.
// Ported from pkg/joycode/client.go: prepareBody() (lines 123-139) and
// prepareAnthropicBody() (lines 141-154).

import { hexId } from '../util/id';
import { CLIENT_VERSION } from './headers';

/**
 * Build the standard JoyCode request envelope, merging caller-supplied extras.
 * See pkg/joycode/client.go:123-139 (prepareBody).
 *
 * - Sets tenant=JOYCODE, client=JoyCode, clientVersion, sessionId (stable per
 *   client — passed in, NOT regenerated here), userId.
 * - chatId and requestId are generated per call unless the caller already
 *   supplied them in `extra` (Go: lines 129-134).
 * - Caller keys win on conflict (Go merges extra last, lines 135-137).
 */
export function prepareBody(
  userId: string,
  sessionId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    tenant: 'JOYCODE',
    userId,
    client: 'JoyCode',
    clientVersion: CLIENT_VERSION,
    sessionId,
  };
  if (!('chatId' in extra)) {
    body.chatId = hexId();
  }
  if (!('requestId' in extra)) {
    body.requestId = hexId();
  }
  // Merge caller extras last so they override the defaults.
  for (const k of Object.keys(extra)) {
    body[k] = extra[k];
  }
  return body;
}

/**
 * Build the Anthropic-native JoyCode request envelope.
 * See pkg/joycode/client.go:141-154 (prepareAnthropicBody).
 *
 * tenant=JD, language=UNKNOWN, stream=true (hardcoded); caller extras override.
 * Note: unlike prepareBody, no chatId/requestId/sessionId are injected here.
 */
export function prepareAnthropicBody(
  userId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    tenant: 'JD',
    userId,
    client: 'JoyCode',
    clientVersion: CLIENT_VERSION,
    language: 'UNKNOWN',
    stream: true,
  };
  for (const k of Object.keys(extra)) {
    body[k] = extra[k];
  }
  return body;
}
