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

  // 1b. Claude Code ships as a Bun-compiled binary whose UA is the runtime's
  //     "Bun/<ver>" (verified from the local binary; there is no "claude-cli"
  //     UA). It is the dominant Bun+Anthropic client, so a Bun runtime UA on
  //     /v1/messages is treated as Claude Code. The raw UA is stored separately
  //     so this heuristic can be refined from observed data.
  if (/^bun\//i.test(ua) && endpoint.includes('/v1/messages')) return 'Claude Code';

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

/**
 * Truncate a raw User-Agent for storage (defends against pathologically large
 * UAs bloating request_logs). 256 chars is ample for any real client UA.
 */
export function truncateUA(userAgent: string | null): string {
  return (userAgent ?? '').trim().slice(0, 256);
}
