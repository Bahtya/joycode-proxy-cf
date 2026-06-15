// OpenAI request/response translation for the JoyCode upstream.
// Ports pkg/openai/translate.go (TranslateRequest, TranslateResponse).
//
// The JoyCode /api/saas/openai/v1/chat/completions endpoint already speaks the
// OpenAI Chat Completions shape, so translation is mostly an envelope pass:
// we re-project the inbound body into a clean record (mirroring Go's field
// handling) and wrap the upstream response in an OpenAI completion envelope.
//
// TranslateStreamChunk (translate.go:81-97) is intentionally NOT ported: the
// Go server pipes the JoyCode SSE stream through verbatim (chat.go:88-101) and
// TranslateStreamChunk is dead code in the live path. The CF port does the same
// verbatim pipe — see functions/v1/chat/completions.ts.

import { DEFAULT_MODEL } from '../joycode/models';

/** A permissive OpenAI Chat Completions request shape (translate.go:9-19). */
export interface OpenAIChatRequest {
  model: string;
  messages?: unknown;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: unknown;
  tool_choice?: unknown;
  stop?: unknown;
  thinking?: unknown;
  // Other passthrough fields are preserved as-is at the top level.
  [k: string]: unknown;
}

/**
 * Translate (project) an OpenAI request body into the JoyCode upstream body.
 * Ports TranslateRequest (translate.go:12-46).
 *
 * The inbound body is already OpenAI-shaped; this re-builds a clean record so
 * that only the fields JoyCode expects are forwarded, matching Go's selective
 * assembly. tools / messages arrive as pre-parsed JSON values here (the Pages
 * Function has already JSON.parsed the request body), so where Go used
 * json.Unmarshal on json.RawMessage we simply pass the value through verbatim —
 * the swallowing of unmarshal errors translates to "if absent/invalid, omit".
 *
 * tool_choice and stop are passed verbatim (translate.go:36-41).
 * thinking is only forwarded for reasoning-capable models (translate.go:42-44);
 * we delegate that gate to the caller's model knowledge via REASONING_MODELS.
 */
export function translateOpenAIRequest(
  body: OpenAIChatRequest,
  reasonModels: ReadonlySet<string> = REASONING_MODELS
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    model: body.model,
    stream: body.stream === true,
  };

  // messages: forward if present and truthy (Go: len(req.Messages) > 0).
  if (body.messages != null) {
    out['messages'] = body.messages;
  }
  // max_tokens: only when > 0 (Go: req.MaxTokens > 0).
  if (typeof body.max_tokens === 'number' && body.max_tokens > 0) {
    out['max_tokens'] = body.max_tokens;
  }
  // temperature / top_p: forward when defined (Go: *float64 != nil).
  if (body.temperature !== undefined && body.temperature !== null) {
    out['temperature'] = body.temperature;
  }
  if (body.top_p !== undefined && body.top_p !== null) {
    out['top_p'] = body.top_p;
  }
  // tools: forward if present (Go: len(req.Tools) > 0).
  if (body.tools != null) {
    out['tools'] = body.tools;
  }
  // tool_choice: verbatim (Go: json.RawMessage pass-through, only when len>0).
  if (body.tool_choice !== undefined && body.tool_choice !== null && body.tool_choice !== '') {
    out['tool_choice'] = body.tool_choice;
  }
  // stop: verbatim (Go: json.RawMessage, only when len>0).
  if (body.stop !== undefined && body.stop !== null && body.stop !== '') {
    out['stop'] = body.stop;
  }
  // thinking: verbatim only for reasoning-capable models (Go: translate.go:42-44).
  if (
    body.thinking !== undefined &&
    body.thinking !== null &&
    body.thinking !== '' &&
    typeof body.model === 'string' &&
    reasonModels.has(body.model)
  ) {
    out['thinking'] = body.thinking;
  }

  return out;
}

/**
 * Wrap a JoyCode upstream non-stream response in the OpenAI completion envelope.
 * Ports TranslateResponse (translate.go:49-59).
 *
 * `choices` and `usage` are taken verbatim from the upstream map; the envelope
 * adds id/object/created/model/system_fingerprint exactly as Go does.
 */
export function translateOpenAIResponse(
  jcResp: Record<string, unknown>,
  model: string
): Record<string, unknown> {
  return {
    id: `chatcmpl-${shortId()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: jcResp['choices'],
    usage: jcResp['usage'],
    system_fingerprint: `fp_${shortId()}`,
  };
}

/**
 * Translate JoyCode models into the OpenAI /v1/models list shape.
 * Ports TranslateModels (translate.go:62-79).
 */
export function translateOpenAIModels(
  jcModels: { modelId?: string; label?: string }[]
): Record<string, unknown> {
  const data = jcModels.map((m) => {
    const mid = m.modelId || m.label || '';
    const entry: Record<string, unknown> = {
      id: mid,
      object: 'model',
      created: 1700000000,
      owned_by: 'joycode',
    };
    const caps = MODEL_CAPABILITIES[mid];
    if (caps) entry['capabilities'] = caps;
    return entry;
  });
  return { object: 'list', data };
}

/** Models that accept thinking/reasoning control. Mirrors ReasoningModels (types.go:41-43). */
export const REASONING_MODELS: ReadonlySet<string> = new Set(['GLM-5.1', 'Kimi-K2.6', 'MiniMax-M2.7']);

/** Model capability descriptors. Mirrors ModelCapabilities (types.go:28-38). */
export const MODEL_CAPABILITIES: Record<string, ModelCapability> = {
  'JoyAI-Code-1.5': { max_tokens: 64000, ctx: 200000 },
  'Claude-Opus-4.7': { max_tokens: 32000, ctx: 200000 },
  'MiniMax-M2.7': { reasoning: true, max_tokens: 16384, ctx: 200000 },
  'Kimi-K2.6': { vision: true, reasoning: true, max_tokens: 16384, ctx: 200000 },
  'GLM-5.1': { reasoning: true, max_tokens: 16384, ctx: 200000 },
  'GLM-5': { max_tokens: 8192, ctx: 200000 },
  'Doubao-Seed-2.0-pro': { max_tokens: 16384, ctx: 200000 },
};

export interface ModelCapability {
  vision?: boolean;
  reasoning?: boolean;
  max_tokens: number;
  ctx: number;
}

/**
 * Resolve the model to use for a request. Ports ResolveModel (translate.go:106-119).
 *
 * If the client-specified model is a known JoyCode model, pass it through;
 * otherwise fall back to the account default, then the system default, then
 * the global DEFAULT_MODEL.
 */
export function resolveModel(
  model: string,
  accountDefault: string,
  systemDefault: string,
  knownModels: readonly string[]
): string {
  if (knownModels.includes(model)) return model;
  if (accountDefault) return accountDefault;
  if (systemDefault) return systemDefault;
  return knownModels[0] ?? DEFAULT_MODEL;
}

/** Opaque short id for completion/fingerprint envelopes. Mirrors newShortID (translate.go:99-101). */
function shortId(): string {
  // Date.now() ms precision; multiply and mod 1e12 to mimic Go's UnixNano%1e12.
  return String((Date.now() * 1000) % 1e12);
}
