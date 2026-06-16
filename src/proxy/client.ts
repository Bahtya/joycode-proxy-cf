// Best-effort inbound client identification for request logging / dashboards.
//
// The inbound User-Agent is the primary signal for which app is calling the
// proxy (Claude Code, Codex, Cursor, ...). We normalize known clients to friendly
// names; for unknown UAs we fall back to the leading product token (still
// readable, e.g. "claude-cli"), and finally to "其他". The map is intentionally
// small and easy to extend — after deploy, inspect the "其他" / raw-token buckets
// to calibrate.

/** Substring (lowercased UA → display name) for well-known AI coding clients. */
const KNOWN_CLIENTS: ReadonlyArray<[string, string]> = [
  ['claude-cli', 'Claude Code'],
  ['claude code', 'Claude Code'],
  ['claude-code', 'Claude Code'],
  ['codex', 'Codex'],
  ['cursor', 'Cursor'],
  ['windsurf', 'Windsurf'],
  ['codeium', 'Codeium'],
  ['cline', 'Cline'],
  ['continue', 'Continue'],
  ['aider', 'Aider'],
  ['roo-cline', 'Roo Code'],
  ['roo code', 'Roo Code'],
  ['copilot', 'GitHub Copilot'],
  ['anthropic', 'Anthropic SDK'],
  ['openai', 'OpenAI SDK'],
];

/** Leading-token values that aren't a real product name (generic HTTP libs / browsers). */
const NOISE_TOKENS = new Set([
  'mozilla', 'curl', 'libcurl', 'wget', 'python-requests', 'python-urllib',
  'axios', 'node-fetch', 'undici', 'got', 'okhttp', 'java', 'apache-http',
  'go-http-client', 'guzzlehttp', 'requests', 'dart', 'postmanruntime', '',
]);

/**
 * Identify the calling client from its User-Agent (and, as a last resort, the
 * endpoint protocol). Never throws; always returns a non-empty label.
 */
export function detectClient(userAgent: string | null, endpoint = ''): string {
  const ua = (userAgent ?? '').trim();
  const lower = ua.toLowerCase();

  // 1. Known client by substring match.
  for (const [needle, name] of KNOWN_CLIENTS) {
    if (lower.includes(needle)) return name;
  }

  // 2. Leading product token (e.g. "claude-cli", "Cursor", "aider") if it isn't
  //    generic HTTP-library noise.
  if (ua !== '') {
    const token = ua.split(/[\s/(]/)[0]?.toLowerCase() ?? '';
    if (token && !NOISE_TOKENS.has(token)) {
      return token;
    }
  }

  // 3. Protocol hint from the endpoint, then generic fallback.
  if (endpoint.includes('/v1/messages')) return 'Anthropic';
  if (endpoint.includes('/v1/chat')) return 'OpenAI';
  return '其他';
}
