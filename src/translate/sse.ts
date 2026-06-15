// SSE (Server-Sent Events) encoding / parsing helpers.
//
// Pure utilities shared by the Anthropic streaming handler and any consumer
// that needs to read upstream OpenAI-style SSE chunks. No Cloudflare-runtime
// globals are required beyond JSON.
//
// Ported from pkg/anthropic/translate.go:516-520 (FormatSSE) plus a buffered
// chunk parser derived from the bufio.Scanner loop in handler.go:300-447.

/**
 * Encode a single SSE event frame.
 *
 * Produces the canonical two-line frame:
 *
 * ```
 * event: <eventType>\n
 * data: <json>\n
 * \n
 * ```
 *
 * Mirrors `FormatSSE` (translate.go:517-520): `json.Marshal` of the payload,
 * then `fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, jsonData)`.
 *
 * @param eventType the SSE event name (e.g. "message_start", "ping").
 * @param data      the payload; JSON.stringify'd verbatim.
 * @returns the complete frame as a string, ready to enqueue into a stream.
 */
export function encodeSSE(eventType: string, data: unknown): string {
  const jsonData = JSON.stringify(data);
  return `event: ${eventType}\ndata: ${jsonData}\n\n`;
}

/** A parsed SSE event: an optional explicit event name plus its data payload. */
export interface SSEEvent {
  event?: string;
  data: string;
}

/**
 * Parse a buffered SSE blob into complete events plus any trailing partial.
 *
 * SSE frames are separated by a blank line (`\n\n`). Each frame may contain:
 *   - an `event:` line  → becomes `event`
 *   - one or more `data:` lines → concatenated with `\n` into `data`
 *   - (comment `:` lines and `id:`/`retry:` lines are ignored, matching Go's
 *     scanner which only inspects `event:` and `data:` prefixes)
 *
 * Only complete frames (terminated by `\n\n`) are returned in `events`. A
 * frame without a closing `\n\n` is a partial — returned in `rest` so the
 * caller can prepend it to the next chunk. This mirrors how the Go handler
 * feeds complete lines into `ParseStreamChunk` one at a time.
 *
 * @param buffer raw text accumulated from a stream read.
 * @returns `{ events, rest }` — parsed complete events and the leftover tail.
 */
export function parseSSEChunk(buffer: string): { events: SSEEvent[]; rest: string } {
  const events: SSEEvent[] = [];

  // Find the last complete frame boundary. We split on "\n\n"; the final piece
  // is incomplete unless the buffer ends with "\n\n".
  const parts = buffer.split('\n\n');

  // If the buffer ends exactly with "\n\n", split produces a trailing "" that
  // is NOT a partial — drop it. Otherwise the last element is a partial frame.
  let rest = '';
  if (!buffer.endsWith('\n\n')) {
    const last = parts.pop();
    rest = last ?? '';
  } else {
    // Trailing empty element from the terminal "\n\n": discard.
    parts.pop();
  }

  for (const frame of parts) {
    if (frame === '') continue;
    let event: string | undefined;
    const dataLines: string[] = [];
    // Frames may use "\n" or "\r\n" line endings; split on "\n" and trim "\r".
    for (const rawLine of frame.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith(':')) {
        // SSE comment line — ignore.
        continue;
      }
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        // Per spec, a single leading space after the colon is stripped.
        const value = line.slice('data:'.length);
        dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
        continue;
      }
      // id: / retry: / unknown — ignore (Go scanner ignores these too).
    }
    if (event === undefined && dataLines.length === 0) continue;
    events.push({ event, data: dataLines.join('\n') });
  }

  return { events, rest };
}
