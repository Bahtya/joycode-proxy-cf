// Anthropic Messages API ↔ OpenAI (JoyCode) protocol translation.
//
// Pure, synchronous translators (no I/O, no Cloudflare-runtime globals beyond
// JSON / crypto.getRandomValues via id helpers). Ported 1:1 from
// pkg/anthropic/translate.go (line refs inline) and pkg/anthropic/types.go.
//
// These power BOTH the non-streaming handler (translateRequest/translateResponse)
// and the streaming handler (StreamChunk type, fixPartialJSON, and the id
// synthesis rules it depends on).
//
// JSON boundaries are intentionally typed loosely (`unknown` / `Record<string,
// unknown>` / careful casts) to mirror Go's `map[string]interface{}` untyped
// access against dynamic upstream shapes. Under strict TS + noUncheckedIndexedAccess,
// every indexing is guarded.

import { MODELS, DEFAULT_MODEL } from '../joycode/models';
import { callId, msgId, tooluId } from '../util/id';

// ---------------------------------------------------------------------------
// Public request / response shapes (subset of pkg/anthropic/types.go)
// ---------------------------------------------------------------------------

/**
 * Anthropic content block as received in a request message.
 *
 * Matches the `contentBlock` struct (translate.go:202-212). `content` and
 * `input` are kept as `unknown` because the upstream payload may be a string,
 * an array of text blocks, or an arbitrary JSON value.
 */
export interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  /** tool_result fields */
  tool_use_id?: string;
  content?: unknown;
}

/**
 * Anthropic tool definition (types.go:30-34).
 */
export interface AnthropicTool {
  name?: string;
  description?: string;
  input_schema?: unknown;
}

/**
 * Anthropic Messages API request body, loosely typed.
 *
 * `system` and `tool_choice` arrive as raw JSON (Go `json.RawMessage`); here
 * they are `unknown` and resolved by parseContent / convertToolChoice.
 * `content` of each message is likewise `unknown`.
 */
export interface AnthropicMessage {
  role?: string;
  content?: unknown;
}

export interface AnthropicRequest {
  model?: string;
  max_tokens?: number;
  messages?: AnthropicMessage[];
  stream?: boolean;
  system?: unknown;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: unknown;
  thinking?: { type?: string; budget_tokens?: number };
}

// ---------------------------------------------------------------------------
// Model resolution (translate.go:186-199)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective model id: passthrough if in the catalog, else fall back
 * to the account default, then system default, then the built-in default.
 *
 * Mirrors resolveModel (translate.go:186-199).
 */
export function resolveModel(
  model: string | undefined,
  accountDefault: string,
  systemDefault: string,
  knownModels: readonly string[] = MODELS,
): string {
  const m = model ?? '';
  if (knownModels.includes(m)) return m;
  if (accountDefault !== '') return accountDefault;
  if (systemDefault !== '') return systemDefault;
  return knownModels[0] ?? DEFAULT_MODEL;
}

// ---------------------------------------------------------------------------
// Request translation (translate.go:15-43)
// ---------------------------------------------------------------------------

/**
 * Convert an Anthropic Messages request into the OpenAI-shaped body sent to
 * JoyCode's color gateway (api-ai.jd.com, functionId=chat_completions).
 *
 * Faithful port of TranslateRequest (translate.go:15-43):
 *   - model: resolved via resolveModel (accountDefault/systemDefault optional)
 *   - messages: buildMessages (system → messages[0] role:system)
 *   - stream / max_tokens copied through
 *   - temperature / top_p / stop_sequences / tools / tool_choice added only
 *     when present (nil-guards match Go's `!= nil` / `len() > 0`)
 *
 * @param req            parsed Anthropic request
 * @param accountDefault per-account default model id (may be '')
 * @param systemDefault  global default model id (may be '')
 */
export function translateRequest(
  req: AnthropicRequest,
  accountDefault = '',
  systemDefault = '',
): Record<string, unknown> {
  const model = resolveModel(req.model, accountDefault, systemDefault);
  const messages = buildMessages(req);

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: req.stream ?? false,
    max_tokens: req.max_tokens,
  };
  if (req.temperature !== undefined) {
    body['temperature'] = req.temperature;
  }
  if (req.top_p !== undefined) {
    body['top_p'] = req.top_p;
  }
  if (req.stop_sequences && req.stop_sequences.length > 0) {
    body['stop'] = req.stop_sequences;
  }
  if (req.tools && req.tools.length > 0) {
    body['tools'] = convertTools(req.tools);
  }
  if (req.tool_choice !== undefined && req.tool_choice !== null) {
    const tc = convertToolChoice(req.tool_choice);
    if (tc !== undefined) {
      body['tool_choice'] = tc;
    }
  }
  return body;
}

// ---------------------------------------------------------------------------
// Tools (translate.go:109-124, 437-463)
// ---------------------------------------------------------------------------

/**
 * Convert Anthropic tools to OpenAI function-calling format.
 *
 * Each `{name, description, input_schema}` becomes
 * `{type:'function', function:{name, description, parameters: input_schema verbatim}}`.
 *
 * Port of convertToolsToOpenAI (translate.go:109-124).
 */
export function convertTools(tools: AnthropicTool[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const t of tools) {
    result.push({
      type: 'function',
      function: {
        name: t.name ?? '',
        description: t.description ?? '',
        parameters: t.input_schema,
      },
    });
  }
  return result;
}

/**
 * Convert an Anthropic `tool_choice` to OpenAI's `tool_choice`.
 *
 *   auto   → "auto"
 *   any    → "required"
 *   none   → "none"
 *   tool   → {type:'function', function:{name}} (or "auto" if name empty)
 *   unknown → undefined (omitted from body)
 *
 * Port of convertToolChoice (translate.go:437-463). Returns `undefined` for
 * unparseable / unknown input so the caller can omit the field.
 */
export function convertToolChoice(raw: unknown): unknown {
  // The Anthropic shape is `{type, name}`; tolerate a pre-parsed object or a
  // JSON string. Go uses json.Unmarshal which only accepts valid JSON.
  let tc: { type?: string; name?: string };
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return undefined;
      tc = parsed as { type?: string; name?: string };
    } catch {
      return undefined; // json.Unmarshal error → nil
    }
  } else if (typeof raw === 'object' && raw !== null) {
    tc = raw as { type?: string; name?: string };
  } else {
    return undefined;
  }

  switch (tc.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'tool':
      if (tc.name && tc.name !== '') {
        return {
          type: 'function',
          function: { name: tc.name },
        };
      }
      return 'auto';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Content parsing (translate.go:389-411, 355-377, 379-387)
// ---------------------------------------------------------------------------

/**
 * Parse a request `content`/`system` field into a plain string.
 *
 * - string → returned as-is
 * - array of `{type:'text', text}` blocks → text parts joined by '\n'
 * - anything else → JSON-stringified fallback (matches Go `string(raw)`)
 *
 * Port of parseContent (translate.go:389-411).
 */
export function parseContent(content: unknown): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (b !== null && typeof b === 'object') {
        const block = b as { type?: string; text?: string };
        if (block.type === 'text') {
          parts.push(block.text ?? '');
        }
      }
    }
    return parts.join('\n');
  }
  // Non-array object / number / etc: fall back to raw JSON like Go's string(raw).
  try {
    return JSON.stringify(content);
  } catch {
    return '';
  }
}

/**
 * Extract concatenated text from a list of content blocks.
 *
 * Port of extractText (translate.go:379-387): joins every `{type:'text'}`
 * block's text with '\n'.
 */
export function extractText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      parts.push(b.text ?? '');
    }
  }
  return parts.join('\n');
}

/**
 * Extract the string content of a tool_result block.
 *
 * - string content → returned as-is
 * - array of `{type:'text', text}` → text parts joined by '\n'
 * - empty → ''
 * - else → JSON fallback
 *
 * Port of extractToolResultContent (translate.go:355-377).
 */
function extractToolResultContent(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const b of raw) {
      if (b !== null && typeof b === 'object') {
        const block = b as { type?: string; text?: string };
        if (block.type === 'text') {
          parts.push(block.text ?? '');
        }
      }
    }
    return parts.join('\n');
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Message building (translate.go:214-353)
// ---------------------------------------------------------------------------

/**
 * Build the OpenAI `messages` array from an Anthropic request.
 *
 * Port of buildMessages (translate.go:214-246):
 *   1. If a non-empty `system` is present, prepend `{role:'system', content:<parseContent(system)>}`.
 *   2. Pre-scan ALL assistant messages collecting tool_use ids into a Set so
 *      orphan tool_results can be stripped later (translate.go:225-238).
 *   3. For each message dispatch by role via convertMessage; flatten results.
 *
 * The orphan-tool_result drop is an intentional bug-fix — preserved exactly.
 */
export function buildMessages(req: AnthropicRequest): Record<string, unknown>[] {
  const msgs: Record<string, unknown>[] = [];

  if (req.system !== undefined && req.system !== null) {
    const sys = parseContent(req.system);
    if (sys !== '') {
      msgs.push({ role: 'system', content: sys });
    }
  }

  const toolUseIDs = new Set<string>();
  for (const m of req.messages ?? []) {
    if (m.role === 'assistant') {
      const blocks = asContentBlocks(m.content);
      for (const b of blocks) {
        if (b.type === 'tool_use' && b.id && b.id !== '') {
          toolUseIDs.add(b.id);
        }
      }
    }
  }

  for (const m of req.messages ?? []) {
    const converted = convertMessage(m.role ?? '', m.content, toolUseIDs);
    for (const c of converted) msgs.push(c);
  }
  return msgs;
}

/**
 * Coerce a message `content` field into a list of ContentBlock.
 *
 * Returns [] when the content is a plain string or unparseable (the caller
 * handles those cases separately). Mirrors the Go `json.Unmarshal(.., &blocks)`
 * attempts in convertMessage.
 */
function asContentBlocks(content: unknown): ContentBlock[] {
  if (Array.isArray(content)) {
    return content.filter(
      (b): b is ContentBlock => b !== null && typeof b === 'object',
    );
  }
  return [];
}

/**
 * Convert a single Anthropic message into one or more OpenAI messages.
 *
 * Port of convertMessage (translate.go:249-270):
 *   - plain string content → `[{role, content:<string>}]`
 *   - assistant role → convertAssistantBlocks (one message)
 *   - user role     → convertUserBlocks (drops orphan tool_results; may emit
 *                     multiple {role:'tool'} messages + a trailing {role:'user'})
 *   - any other role → `[{role, content:<extractText>}]`
 *   - unparseable non-string content → content becomes its raw JSON
 */
function convertMessage(
  role: string,
  content: unknown,
  toolUseIDs: Set<string>,
): Record<string, unknown>[] {
  // Simple string content passes straight through.
  if (typeof content === 'string') {
    return [{ role, content }];
  }

  const blocks = asContentBlocks(content);
  if (blocks.length === 0) {
    // Not a string and not (or empty) array: fall back to raw JSON string,
    // matching Go's `string(raw)` branch.
    const fallback =
      content === undefined || content === null ? '' : safeStringify(content);
    return [{ role, content: fallback }];
  }

  switch (role) {
    case 'assistant':
      return [convertAssistantBlocks(blocks)];
    case 'user':
      return convertUserBlocks(blocks, toolUseIDs);
    default:
      return [{ role, content: extractText(blocks) }];
  }
}

/**
 * Convert an assistant message's content blocks into an OpenAI assistant message.
 *
 * Port of convertAssistantBlocks (translate.go:273-312):
 *   - `tool_use` blocks → `tool_calls[] = {id (fallback callId() if ''), type:'function',
 *     function:{name, arguments: JSON.stringify(input) or '{}'}}`
 *   - `text` blocks → joined with '\n' into `content`
 *   - when tool_calls are present and content is empty, content is set to null
 *
 * Note: Go emits `input` verbatim as a JSON string (`string(b.Input)` where
 * Input is already a raw JSON byte slice). Here `input` arrives as a parsed JS
 * value, so JSON.stringify reproduces the same wire bytes.
 */
export function convertAssistantBlocks(
  blocks: ContentBlock[],
): Record<string, unknown> {
  const textParts: string[] = [];
  const toolCalls: Record<string, unknown>[] = [];

  for (const b of blocks) {
    switch (b.type) {
      case 'text':
        textParts.push(b.text ?? '');
        break;
      case 'tool_use': {
        let args = '{}';
        if (b.input !== undefined && b.input !== null) {
          args = safeStringify(b.input) ?? '{}';
        }
        let id = b.id ?? '';
        if (id === '') {
          id = callId(); // "call_" + newID()
        }
        toolCalls.push({
          id,
          type: 'function',
          function: {
            name: b.name ?? '',
            arguments: args,
          },
        });
        break;
      }
      default:
        // other block types ignored (matches Go's switch)
        break;
    }
  }

  const msg: Record<string, unknown> = {
    role: 'assistant',
    content: textParts.join('\n'),
  };
  if (toolCalls.length > 0) {
    msg['tool_calls'] = toolCalls;
    if ((msg['content'] as string) === '') {
      msg['content'] = null;
    }
  }
  return msg;
}

/**
 * Convert a user message containing tool_result blocks into OpenAI messages.
 *
 * Port of convertUserBlocks (translate.go:317-353):
 *   - each `tool_result` whose tool_use_id is NOT in `toolUseIDs` is DROPPED
 *     (orphan from upstream truncation — intentional bug-fix)
 *   - each surviving tool_result → `{role:'tool', tool_call_id, content}`
 *   - any accumulated text → trailing `{role:'user', content}` (only when at
 *     least one tool_result was emitted)
 *   - if there were no tool_results, a single `{role:'user', content:<text>}`
 *     message is returned (empty string when no text)
 */
export function convertUserBlocks(
  blocks: ContentBlock[],
  toolUseIDs: Set<string>,
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const textParts: string[] = [];

  for (const b of blocks) {
    switch (b.type) {
      case 'text':
        textParts.push(b.text ?? '');
        break;
      case 'tool_result': {
        // Drop orphaned tool_results whose tool_use was removed by truncation.
        if (b.tool_use_id && b.tool_use_id !== '' && !toolUseIDs.has(b.tool_use_id)) {
          continue;
        }
        const resultText = extractToolResultContent(b.content);
        result.push({
          role: 'tool',
          tool_call_id: b.tool_use_id ?? '',
          content: resultText,
        });
        break;
      }
      default:
        break;
    }
  }

  // If there's remaining text alongside tool_results, append a trailing user msg.
  if (textParts.length > 0 && result.length > 0) {
    result.push({ role: 'user', content: textParts.join('\n') });
  }

  // No tool_result blocks: collapse to a single user message.
  if (result.length === 0) {
    return [{ role: 'user', content: textParts.join('\n') }];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Response translation (translate.go:127-184, 413-426)
// ---------------------------------------------------------------------------

/** Anthropic token-usage object (types.go:66-69). */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * Extract Anthropic usage from a JoyCode (OpenAI-shaped) response.
 *
 * Maps `usage.prompt_tokens` → input_tokens and `usage.completion_tokens` →
 * output_tokens. Defaults to 0 when absent. Port of extractUsage
 * (translate.go:413-426).
 */
export function extractUsage(jcResp: Record<string, unknown>): Usage {
  const u: Usage = { input_tokens: 0, output_tokens: 0 };
  const usage = jcResp['usage'];
  if (!usage || typeof usage !== 'object') return u;
  const pt = (usage as Record<string, unknown>)['prompt_tokens'];
  const ct = (usage as Record<string, unknown>)['completion_tokens'];
  if (typeof pt === 'number') u.input_tokens = Math.trunc(pt);
  if (typeof ct === 'number') u.output_tokens = Math.trunc(ct);
  return u;
}

/** A response content block as serialized to Anthropic clients (types.go:57-63). */
export interface ResponseContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

/** Anthropic Messages API response object (types.go:45-54). */
export interface MessageResponse {
  id: string;
  type: string;
  role: string;
  content: ResponseContentBlock[];
  model: string;
  stop_reason: string | null;
  stop_sequence?: string | null;
  usage: Usage;
}

/**
 * Convert a JoyCode (OpenAI-shaped) response into an Anthropic Message response.
 *
 * Port of TranslateResponse (translate.go:127-184):
 *   - id: "msg_" + newID() (msgId())
 *   - empty choices → single empty text block, stop_reason 'end_turn'
 *   - tool_calls present → one `tool_use` block per call (id fallback tooluId(),
 *     input = JSON.parse(arguments) coerced to {} on invalid), stop_reason 'tool_use'
 *   - else → single text block from message.content, stop_reason 'end_turn'
 *
 * @param jcResp  parsed JoyCode response body
 * @param reqModel the model id to echo back in the response
 */
export function translateResponse(
  jcResp: Record<string, unknown>,
  reqModel: string,
): MessageResponse {
  const msgID = msgId();
  const usage = extractUsage(jcResp);

  const choices = jcResp['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    return {
      id: msgID,
      type: 'message',
      role: 'assistant',
      model: reqModel,
      content: [{ type: 'text', text: '' }],
      stop_reason: 'end_turn',
      usage,
    };
  }

  const choice = choices[0];
  const msg =
    choice && typeof choice === 'object'
      ? (choice as Record<string, unknown>)
      : {};

  const content: ResponseContentBlock[] = [];
  let stopReason = 'end_turn';

  const toolCalls = msg['tool_calls'];
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    stopReason = 'tool_use';
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== 'object') continue;
      const tcMap = tc as Record<string, unknown>;
      const fnRaw = tcMap['function'];
      const fn =
        fnRaw && typeof fnRaw === 'object'
          ? (fnRaw as Record<string, unknown>)
          : {};
      const name = typeof fn['name'] === 'string' ? (fn['name'] as string) : '';
      const argsStrRaw = fn['arguments'];
      let argsStr = typeof argsStrRaw === 'string' ? argsStrRaw : '';
      let id = typeof tcMap['id'] === 'string' ? (tcMap['id'] as string) : '';
      if (id === '') {
        id = tooluId(); // "toolu_" + newID()
      }

      // Coerce invalid/empty arguments to {}.
      let input: unknown;
      if (argsStr === '' || !isValidJSON(argsStr)) {
        argsStr = '{}';
        input = {};
      } else {
        try {
          input = JSON.parse(argsStr);
        } catch {
          input = {};
        }
      }
      void argsStr; // argsStr retained for parity with Go (input holds the parsed value)

      content.push({
        type: 'tool_use',
        id,
        name,
        input,
      });
    }
  } else {
    const text = typeof msg['content'] === 'string' ? (msg['content'] as string) : '';
    content.push({ type: 'text', text });
  }

  return {
    id: msgID,
    type: 'message',
    role: 'assistant',
    model: reqModel,
    content,
    stop_reason: stopReason,
    usage,
  };
}

// ---------------------------------------------------------------------------
// Streaming chunk shape (translate.go:470-491)
// ---------------------------------------------------------------------------

/** Function-call delta inside a streaming tool_call. */
export interface StreamToolCallFunction {
  name?: string;
  arguments?: string;
}

/** A single tool_call delta within a streaming chunk's delta. */
export interface StreamToolCall {
  id?: string;
  index?: number;
  type?: string;
  function?: StreamToolCallFunction;
}

/** The `delta` object inside a streaming choice. */
export interface StreamDelta {
  content?: string;
  tool_calls?: StreamToolCall[];
}

/** A choice inside a streaming chunk (translate.go:472-486). */
export interface StreamChoice {
  delta?: StreamDelta;
  finish_reason?: string | null;
}

/** Usage object inside a streaming chunk (translate.go:487-490). */
export interface StreamUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

/**
 * Shape of a single JoyCode (OpenAI-format) SSE data payload.
 *
 * Port of StreamChunk (translate.go:470-491). `usage` is null when the chunk
 * carries no usage (e.g. deltas); `choices[].finish_reason` is null until the
 * terminal chunk. Exported so the streaming handler can type its JSON.parse.
 */
export interface StreamChunk {
  choices?: StreamChoice[];
  usage?: StreamUsage | null;
}

// ---------------------------------------------------------------------------
// Partial-JSON repair (handler.go:801-850)
// ---------------------------------------------------------------------------

/**
 * Best-effort repair of truncated tool-argument JSON.
 *
 * Port of fixPartialJSON (handler.go:802-850):
 *   - trim; empty → "{}"
 *   - track string / escape state, object depth, array depth
 *   - if still inside a string, append a closing `"`
 *   - close any open arrays with `]`, then any open objects with `}`
 *
 * Used by the streaming handler when a stream errors mid-tool-call, to emit a
 * syntactically valid (if possibly-empty) `input_json_delta`.
 */
export function fixPartialJSON(s: string): string {
  s = s.trim();
  if (s === '') return '{}';

  let objDepth = 0;
  let arrDepth = 0;
  let inStr = false;
  let escape = false;

  for (const ch of s) {
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inStr) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    switch (ch) {
      case '{':
        objDepth++;
        break;
      case '}':
        objDepth--;
        break;
      case '[':
        arrDepth++;
        break;
      case ']':
        arrDepth--;
        break;
      default:
        break;
    }
  }

  if (inStr) {
    s += '"';
  }
  while (arrDepth > 0) {
    s += ']';
    arrDepth--;
  }
  while (objDepth > 0) {
    s += '}';
    objDepth--;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Small JSON helpers
// ---------------------------------------------------------------------------

/** JSON.stringify that never throws (used at dynamic JSON boundaries). */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '{}';
  }
}

/** True iff s parses as JSON (equivalent of Go's json.Valid). */
function isValidJSON(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}
