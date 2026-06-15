// Small ID helpers using WebCrypto (no deps).

/** Random hex string, `bytes*2` chars long. Default 16 bytes → 32 hex (matches Go newHexID). */
export function hexId(bytes = 16): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i]!.toString(16).padStart(2, '0');
  return out;
}

/** Anthropic-style tool_use id (handler.go synthesizes `toolu_`+newID). */
export function tooluId(): string {
  return 'toolu_' + hexId(12);
}

/** OpenAI-style tool_call id (translate.go convertAssistantBlocks synthesizes `call_`+newID). */
export function callId(): string {
  return 'call_' + hexId(12);
}

/** Anthropic message id. */
export function msgId(): string {
  return 'msg_' + hexId(12);
}
