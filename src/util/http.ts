// Shared HTTP helpers for Pages Functions.

/** Parse a JSON request body; returns {} for empty bodies, throws a 400 Response for invalid JSON. */
export async function readJson<T = unknown>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw jsonError(400, 'invalid JSON body');
  }
}

/** Anthropic-flavored error response. */
export function jsonError(status: number, message: string, extra: Record<string, unknown> = {}): Response {
  return Response.json(
    { type: 'error', error: { type: 'invalid_request_error', message, ...extra } },
    { status }
  );
}

export function authError(message: string): Response {
  return Response.json({ type: 'error', error: { type: 'authentication_error', message } }, { status: 401 });
}

export function notFound(message = 'not found'): Response {
  return Response.json({ type: 'error', error: { type: 'not_found_error', message } }, { status: 404 });
}

export function getBearerToken(request: Request): string | null {
  const h = request.headers.get('authorization') ?? '';
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  return null;
}

/** "YYYY-MM-DD HH:MM:SS" in UTC (matches the D1 datetime('now') format). */
export function nowSec(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

/** Read cookie value from a Cookie / Set-Cookie header by name. */
export function cookieValue(headers: Headers | string, name: string): string | null {
  const raw = typeof headers === 'string' ? headers : headers.get('set-cookie') ?? headers.get('cookie') ?? '';
  // set-cookie may contain multiple cookies comma-joined at top level; split safely.
  for (const part of raw.split(/;|,(?=\s*\w+=)/)) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}
