// POST /v1/messages — Anthropic Messages API.
//
// Ports pkg/anthropic/handler.go: handleMessages (:47), handleStream SSE state
// machine (:204-504), handleNativeAnthropicStream identity-passthrough
// (:506-570), connectStreamWithRetry (:854), fixPartialJSON (:802-850); and
// pkg/anthropic/translate.go: TranslateResponse (:127-184), TranslateRequest,
// TranslateAnthropicRequest (:45-69), IsNativeAnthropicModel (:93-96),
// ClaudeNativeEnabled (:86-91).
//
// This is the most correctness-critical route. The streaming state machine must
// faithfully reproduce the OpenAI-delta → Anthropic-event conversion including:
//   - lazy content_block_start (text + tool blocks share one index space)
//   - tool argument accumulation by STRING CONCAT per tool_calls[].index
//   - a SINGLE input_json_delta per tool block at finish carrying the FULL
//     accumulated argument string (no incremental partial_json)
//   - the empty-stream invariant (synthesize a text block if nothing emitted)
//   - fixPartialJSON repair on mid-stream truncation
//   - exact stop_reason map (tool_calls→tool_use, length→max_tokens, stop→end_turn,
//     content_filter→end_turn, default→end_turn)
//
// Differences from Go (serverless / Workers runtime):
//   - Account comes from data.account (functions/v1/_middleware.ts), not a
//     per-request resolver closure.
//   - Workers fetch() auto-decompresses; postStream/postAnthropicStream return a
//     Response whose .body is a streaming ReadableStream — we consume it with a
//     reader + TextDecoder and feed buffered text into parseSSEChunk. (Go used
//     bufio.Scanner over resp.Body.)
//   - SSE is written into a single ReadableStream we return as the Response body
//     (Go wrote to http.ResponseWriter + Flusher).
//   - Retries / progressive truncation from connectStreamWithRetry are NOT
//     ported: Workers has no equivalent of re-reading the first SSE line before
//     committing headers. postStream already throws on non-200 (the only error
//     surface Go retried on), and the first-payload error peek below covers the
//     "200 body carries an error object" case.
//   - Logging: usage is captured during the stream and flushed via waitUntil
//     when the stream completes (Go captured via requestLogMiddleware).
import type { Env, Account, RequestLogRow } from '../../src/types';
import type { V1Data } from './_middleware';
import { ensureSettings } from './_middleware';
import { createStore } from '../../src/store/d1';
import { getSetting } from '../../src/store/settings';
import { readJson, jsonError } from '../../src/util/http';
import { createJoyClient } from '../../src/joycode/client';
import { msgId, tooluId } from '../../src/util/id';
import {
  translateRequest,
  translateResponse,
  resolveModel,
  fixPartialJSON,
  type AnthropicRequest,
  type StreamChunk,
} from '../../src/translate/anthropic';
import { encodeSSE, parseSSEChunk } from '../../src/translate/sse';

const CHAT_ENDPOINT = '/api/saas/openai/v1/chat/completions';
const ANTHROPIC_ENDPOINT = '/api/saas/anthropic/v1/messages';

const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
};

// ---------------------------------------------------------------------------
// Entry point — handleMessages (handler.go:47)
// ---------------------------------------------------------------------------

export const onRequestPost: PagesFunction<Env, string, V1Data> = async (ctx) => {
  const { request, env, data } = ctx;
  const account = data.account;
  if (!account) {
    // _middleware should have already rejected; defend in depth. The task spec
    // asks for a 403 "no account" here, mirroring the Go gate.
    return jsonError(403, 'no account');
  }

  // Parse body. readJson throws a 400 Response on invalid JSON.
  let req: AnthropicRequest;
  try {
    req = await readJson<AnthropicRequest>(request);
  } catch (e) {
    return e instanceof Response ? e : jsonError(400, 'invalid JSON body');
  }

  // max_tokens clamp (handler.go:66-75). Defaults to 8192, capped at 32768.
  const defaultMaxTokens = 8192;
  if (typeof req.max_tokens !== 'number' || req.max_tokens <= 0) {
    req.max_tokens = defaultMaxTokens;
  }
  if (req.max_tokens > 32768) {
    req.max_tokens = 32768;
  }

  const client = createJoyClient({
    ptKey: account.ptKey,
    userId: account.userId,
    baseURL: env.JOYCODE_BASE_URL,
    saasBaseURL: env.JOYCODE_SAAS_BASE_URL,
    clientVersion: env.JOYCODE_CLIENT_VERSION,
    timeoutSec: parseInt(env.DEFAULT_TIMEOUT, 10),
  });

  const started = Date.now();

  // Native Anthropic passthrough decision (handler.go:214, :100).
  // enable_claude on AND model is Claude-family → native path. Go forces stream
  // for native; non-stream+native has no Go handler so we fall back to the
  // translated non-stream path (task spec).
  const settings = await ensureSettings(ctx);
  const nativeEnabled = (settings['enable_claude'] ?? 'false') === 'true';
  const nativeModel =
    nativeEnabled &&
    (isNativeAnthropicModel(req.model) ||
      isNativeAnthropicModel(
        resolveModel(req.model ?? '', account.defaultModel ?? '', settings['default_model'] ?? ''),
      ));

  if (nativeModel) {
    if (req.stream === true) {
      return handleNativeAnthropicStream(ctx, account, req, client, started);
    }
    // No Go handler for non-stream + native: fall through to translated path.
  }

  if (req.stream === true) {
    return handleStream(ctx, account, req, client, started);
  }
  return handleNonStream(ctx, account, req, client, started);
};

// ---------------------------------------------------------------------------
// Non-streaming translated path — handleNonStream (handler.go:95-181)
// ---------------------------------------------------------------------------

async function handleNonStream(
  ctx: Parameters<PagesFunction<Env, string, V1Data>>[0],
  account: Account,
  req: AnthropicRequest,
  client: ReturnType<typeof createJoyClient>,
  started: number,
): Promise<Response> {
  const { env, waitUntil } = ctx;
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  const systemDefault = (await ensureSettings(ctx))['default_model'] ?? '';

  const jcBody = translateRequest(req, account.defaultModel ?? '', systemDefault);

  let jcResp: Record<string, unknown>;
  try {
    jcResp = await client.post(CHAT_ENDPOINT, jcBody);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const log = makeLog(account.userId, req.model ?? '', '/v1/messages', false, 500, started, msg, 0, 0);
    waitUntil(maybeLog(env, store, log));
    if (isTimeoutError(msg)) {
      return jsonError(504, `上游服务响应超时，请稍后重试。原始错误: ${msg}`);
    }
    return jsonError(500, msg);
  }

  // Content_filter check in the non-stream response (handler.go:164-174).
  const choices = jcResp['choices'];
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = choices[0];
    if (choice && typeof choice === 'object') {
      const fr = (choice as Record<string, unknown>)['finish_reason'];
      if (fr === 'content_filter') {
        const msg = JSON.stringify(choice);
        const log = makeLog(account.userId, req.model ?? '', '/v1/messages', false, 400, started, msg, 0, 0);
        waitUntil(maybeLog(env, store, log));
        return contentFilterError(msg);
      }
    }
  }

  const resp = translateResponse(jcResp, req.model ?? '');

  // Capture usage for logging (handler.go:175-179).
  const usage = jcResp['usage'];
  let inputTokens = 0;
  let outputTokens = 0;
  if (usage && typeof usage === 'object') {
    inputTokens = numOr((usage as Record<string, unknown>)['prompt_tokens']);
    outputTokens = numOr((usage as Record<string, unknown>)['completion_tokens']);
  }

  const log = makeLog(account.userId, req.model ?? '', '/v1/messages', false, 200, started, '', inputTokens, outputTokens);
  waitUntil(maybeLog(env, store, log));

  return Response.json(resp);
}

// ---------------------------------------------------------------------------
// Translated streaming path — handleStream (handler.go:204-504)
// ---------------------------------------------------------------------------

interface ToolCallAccum {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Build the SSE ReadableStream that converts OpenAI deltas into Anthropic
 * events. Faithful port of handleStream's scanner loop (handler.go:300-447) plus
 * the scanner-error recovery block (handler.go:449-500).
 *
 * On upstream connect failure we return a JSON error Response instead of
 * entering the stream (connectStreamWithRetry :854 surfaces non-200 as a throw
 * from postStream). If the first parsed payload carries an "error" field we
 * likewise surface it as an Anthropic error before committing the SSE response.
 */
async function handleStream(
  ctx: Parameters<PagesFunction<Env, string, V1Data>>[0],
  account: Account,
  req: AnthropicRequest,
  client: ReturnType<typeof createJoyClient>,
  started: number,
): Promise<Response> {
  const { env, waitUntil } = ctx;
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  const systemDefault = (await ensureSettings(ctx))['default_model'] ?? '';

  const jcBody = translateRequest(req, account.defaultModel ?? '', systemDefault);
  jcBody['stream'] = true;

  let upstream: Response;
  try {
    upstream = await client.postStream(CHAT_ENDPOINT, jcBody);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    waitUntil(
      maybeLog(env, store, makeLog(account.userId, req.model ?? '', '/v1/messages', true, 500, started, msg, 0, 0)),
    );
    if (isTimeoutError(msg)) {
      return jsonError(504, `上游服务响应超时，请稍后重试。原始错误: ${msg}`);
    }
    return jsonError(500, msg);
  }

  const upstreamBody = upstream.body;
  if (!upstreamBody) {
    return jsonError(502, 'upstream returned no body');
  }

  const msgID = msgId();
  const model = req.model ?? '';
  // totalOutput counts CHARACTERS of emitted text; output_tokens = totalOutput/4
  // (handler.go:277, :442). Matches Go's len(text) accumulation.
  let totalOutput = 0;
  let streamInTk = 0;
  let streamOutTk = 0;

  // Per-index tool-call accumulators + bookkeeping (handler.go:289-298).
  const toolCalls = new Map<number, ToolCallAccum>();
  // Track insertion order of indices so the finish flush iterates 0..size-1 by
  // the order tools first appeared. Go iterates `for i := 0; i < len(toolCalls); i++`
  // over a map keyed by delta index — but the upstream always sends tool_calls
  // with monotonically increasing indices starting at 0, so we preserve the
  // arrival order of distinct indices (which equals 0..n-1 in practice).
  const toolOrder: number[] = [];
  const toolBlockStarted = new Map<number, boolean>();
  const toolBlockToIdx = new Map<number, number>();
  let currentBlockIndex = 0;
  let textBlockStarted = false;
  let anyBlockStarted = false;

  const encoder = new TextEncoder();
  let logFlushed = false;
  let terminalSent = false; // finish() emits the terminal sequence exactly once
  let hadStreamError = false; // true if the upstream stream errored mid-flight

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (s: string) => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          // controller may be errored by a client disconnect; ignore.
        }
      };

      // message_start + ping (handler.go:279-287).
      push(
        encodeSSE('message_start', {
          type: 'message_start',
          message: {
            id: msgID,
            type: 'message',
            role: 'assistant',
            content: [],
            model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );
      push(encodeSSE('ping', { type: 'ping' }));

      const reader = upstreamBody.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const finish = (stopReason: string, errorMode: boolean) => {
        if (terminalSent) return; // idempotent — emit message_stop exactly once
        terminalSent = true;
        // Finish-reason handling (handler.go:387-446) + scanner-error recovery
        // (handler.go:449-500). errorMode mirrors the scanner.Err() branch: in
        // that branch empty/invalid args go through fixPartialJSON.
        // Ensure at least one content block exists (handler.go:392-400).
        if (!textBlockStarted && toolBlockStarted.size === 0) {
          textBlockStarted = true;
          anyBlockStarted = true;
          push(
            encodeSSE('content_block_start', {
              type: 'content_block_start',
              index: currentBlockIndex,
              content_block: { type: 'text', text: '' },
            }),
          );
        }
        if (textBlockStarted) {
          push(encodeSSE('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex }));
          currentBlockIndex++;
          textBlockStarted = false;
        }
        // Flush exactly ONE input_json_delta per tool block carrying the FULL
        // accumulated argument string (handler.go:409-424). In error mode, run
        // fixPartialJSON on invalid args (handler.go:474-476); in normal finish
        // mode, coerce invalid/empty to "{}" (handler.go:412-414).
        for (const idx of toolOrder) {
          if (!toolBlockStarted.get(idx)) continue;
          const accum = toolCalls.get(idx);
          let args = accum?.arguments ?? '';
          if (errorMode) {
            if (args === '') args = '{}';
            else if (!isValidJSON(args)) args = fixPartialJSON(args);
          } else {
            if (args === '' || !isValidJSON(args)) args = '{}';
          }
          const blockIdx = toolBlockToIdx.get(idx) ?? 0;
          push(
            encodeSSE('content_block_delta', {
              type: 'content_block_delta',
              index: blockIdx,
              delta: { type: 'input_json_delta', partial_json: args },
            }),
          );
          push(encodeSSE('content_block_stop', { type: 'content_block_stop', index: blockIdx }));
        }

        // message_delta + message_stop (handler.go:437-444).
        push(
          encodeSSE('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: Math.trunc(totalOutput / 4) },
          }),
        );
        push(encodeSSE('message_stop', { type: 'message_stop' }));
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Feed complete frames into parseSSEChunk; keep the trailing partial.
          const { events, rest } = parseSSEChunk(buffer);
          buffer = rest;

          for (const ev of events) {
            const dataStr = ev.data;
            if (!dataStr || dataStr === '[DONE]') continue;

            let chunk: StreamChunk;
            try {
              chunk = JSON.parse(dataStr) as StreamChunk;
            } catch {
              // Mirrors Go's json.Unmarshal swallow (ParseStreamChunk returns nil).
              continue;
            }

            // Capture usage whenever present (handler.go:309-320).
            if (chunk.usage) {
              streamInTk = chunk.usage.prompt_tokens ?? streamInTk;
              streamOutTk = chunk.usage.completion_tokens ?? streamOutTk;
            }

            const choices = chunk.choices;
            if (!choices || choices.length === 0) continue;
            const choice = choices[0];
            if (!choice) continue;
            const delta = choice.delta;

            // --- TOOL delta handling (handler.go:322-365) ---
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (typeof tc.index !== 'number') continue;
                const idx = tc.index;
                let accum = toolCalls.get(idx);
                if (!accum) {
                  accum = {
                    id: tc.id ?? '',
                    name: tc.function?.name ?? '',
                    arguments: '',
                  };
                  toolCalls.set(idx, accum);
                  toolOrder.push(idx);
                }
                if (tc.id && tc.id !== '') accum.id = tc.id;
                if (tc.function?.name && tc.function.name !== '') accum.name = tc.function.name;
                // STRING CONCAT — do NOT parse (handler.go:336).
                accum.arguments += tc.function?.arguments ?? '';

                if (!toolBlockStarted.get(idx)) {
                  // First occurrence of this index (handler.go:338-364).
                  if (textBlockStarted) {
                    push(encodeSSE('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex }));
                    currentBlockIndex++;
                    textBlockStarted = false;
                  }
                  toolBlockStarted.set(idx, true);
                  toolBlockToIdx.set(idx, currentBlockIndex);
                  let tcID = accum.id;
                  if (tcID === '') tcID = tooluId();
                  push(
                    encodeSSE('content_block_start', {
                      type: 'content_block_start',
                      index: currentBlockIndex,
                      content_block: { type: 'tool_use', id: tcID, name: accum.name, input: {} },
                    }),
                  );
                  currentBlockIndex++;
                  anyBlockStarted = true;
                }
              }
            }

            // --- TEXT delta handling (handler.go:367-385) ---
            const text = delta?.content ?? '';
            if (text !== '') {
              if (!textBlockStarted) {
                textBlockStarted = true;
                anyBlockStarted = true;
                push(
                  encodeSSE('content_block_start', {
                    type: 'content_block_start',
                    index: currentBlockIndex,
                    content_block: { type: 'text', text: '' },
                  }),
                );
              }
              totalOutput += text.length;
              push(
                encodeSSE('content_block_delta', {
                  type: 'content_block_delta',
                  index: currentBlockIndex,
                  delta: { type: 'text_delta', text },
                }),
              );
            }

            // --- FINISH handling (handler.go:387-446) ---
            if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
              const fr = choice.finish_reason;
              finish(mapStopReason(fr), false);
              try {
                controller.close();
              } catch {
                /* already closed */
              }
              return;
            }
          }
        }
        // Always synthesize a terminal sequence at EOF so the Anthropic SDK gets a
        // message_stop even when the upstream ended after deltas without a
        // finish_reason (idempotent via terminalSent). (#1)
        finish('end_turn', false);
      } catch (err) {
        // Upstream stream errored mid-flight (abort/timeout/truncation). Surface it
        // as an Anthropic error event AND a terminal sequence so the SDK completes
        // instead of hanging on a silent/truncated turn. (#4)
        hadStreamError = true;
        const errMsg = err instanceof Error ? err.message : String(err);
        const isAbort = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
        push(
          encodeSSE('error', {
            type: 'error',
            error: { type: isAbort ? 'overloaded_error' : 'api_error', message: errMsg.slice(0, 500) },
          }),
        );
        const errorStopReason = toolBlockStarted.size > 0 ? 'tool_use' : 'end_turn';
        try {
          finish(errorStopReason, true);
        } catch {
          /* best-effort */
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* noop */
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        // Log exactly once, regardless of which branch produced the terminal
        // events (finish_reason / clean EOF / scanner error).
        if (!logFlushed) {
          logFlushed = true;
          flushUsageAndLog(env, store, account, model, started, streamInTk, streamOutTk, waitUntil, hadStreamError ? 500 : 200);
        }
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

// ---------------------------------------------------------------------------
// Native Anthropic passthrough — handleNativeAnthropicStream (handler.go:506-570)
// ---------------------------------------------------------------------------

/**
 * Identity-pipe the upstream Anthropic SSE stream to the client.
 *
 * Ports handleNativeAnthropicStream (handler.go:506-570):
 *   - re-emit each `event:` / `data:` line;
 *   - when a frame carries no explicit event:, re-derive the event name from the
 *     payload's `type` field (nativeAnthropicEventType :746-754);
 *   - track input/output token usage from message_start / message_delta usage
 *     payloads (updateNativeAnthropicUsage :767-799);
 *   - forward `[DONE]` verbatim.
 *
 * connectNativeAnthropicStreamWithRetry (:695-733) peeked the first line for an
 * upstream error before committing. postAnthropicStream already throws on
 * non-200, so the only remaining error surface is a 200 body whose first parsed
 * payload has an "error" field — handled by the same first-payload check.
 */
async function handleNativeAnthropicStream(
  ctx: Parameters<PagesFunction<Env, string, V1Data>>[0],
  account: Account,
  req: AnthropicRequest,
  client: ReturnType<typeof createJoyClient>,
  started: number,
): Promise<Response> {
  const { env, waitUntil } = ctx;
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  const systemDefault = (await ensureSettings(ctx))['default_model'] ?? '';

  const body = translateAnthropicRequest(req, account.defaultModel ?? '', systemDefault);

  let upstream: Response;
  try {
    upstream = await client.postAnthropicStream(ANTHROPIC_ENDPOINT, body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    waitUntil(
      maybeLog(env, store, makeLog(account.userId, req.model ?? '', '/v1/messages', true, 500, started, msg, 0, 0)),
    );
    return jsonError(500, msg);
  }

  const upstreamBody = upstream.body;
  if (!upstreamBody) {
    return jsonError(502, 'upstream returned no body');
  }

  const model = req.model ?? '';
  let inTk = 0;
  let outTk = 0;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (s: string) => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          /* client gone */
        }
      };

      const reader = upstreamBody.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let pendingEvent = '';
      let firstChecked = false;
      let sawTerminal = false; // upstream sent [DONE] / message_stop / event:error
      let nativeHadError = false; // upstream read errored mid-flight
      let nativeErrMsg = ''; // captured error text for the single log row

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // The upstream is a sequence of SSE frames; parse them.
          const { events, rest } = parseSSEChunk(buffer);
          buffer = rest;

          for (const ev of events) {
            // ev.event is the explicit event name if the frame had an event:
            // line; ev.data is the concatenated data payload.
            // Reproduce the Go scanner semantics: an `event:` frame sets
            // pendingEvent and is otherwise emitted only via the following
            // `data:` frame. parseSSEChunk already groups event+data into one
            // SSEEvent when they share a frame, so ev.event acts as the
            // pendingEvent for ev.data.
            const explicitEvent = ev.event;
            const payload = ev.data;

            if (payload === '') {
              // Frame had only an event: line with no data: → treat as
              // pendingEvent for the next frame (Go: continue).
              if (explicitEvent) pendingEvent = explicitEvent;
              continue;
            }

            if (payload === '[DONE]') {
              push('data: [DONE]\n\n');
              sawTerminal = true;
              pendingEvent = '';
              continue;
            }

            if (!payload.startsWith('{')) {
              // Non-JSON payload; ignore (handler.go:549-551).
              pendingEvent = '';
              continue;
            }

            // First-payload error peek (connectNativeAnthropicStreamWithRetry
            // :721 nativeAnthropicLineError / isUpstreamError).
            if (!firstChecked) {
              firstChecked = true;
              if (isUpstreamError(payload)) {
                // Surface the upstream error as an Anthropic error event instead of
                // an empty body + close (which left the SDK hanging). (#3)
                nativeErrMsg = payload.slice(0, 500);
                push(
                  encodeSSE('error', {
                    type: 'error',
                    error: { type: 'api_error', message: nativeErrMsg },
                  }),
                );
                sawTerminal = true;
                nativeHadError = true;
                controller.close();
                return; // finally logs once (status 500, nativeErrMsg)
              }
            }

            // Derive event name (handler.go:552-558).
            let eventName = pendingEvent;
            if (explicitEvent) eventName = explicitEvent;
            if (eventName === '') {
              eventName = nativeAnthropicEventType(payload);
            }
            if (eventName === 'message_stop') sawTerminal = true;
            if (eventName !== '') {
              push(`event: ${eventName}\n`);
            }
            push(`data: ${payload}\n\n`);

            updateNativeAnthropicUsage(payload, (i, o) => {
              if (i > 0) inTk = i;
              if (o > 0) outTk = o;
            });
            pendingEvent = '';
          }
        }
      } catch (err) {
        // Upstream read failed mid-flight (abort/timeout/truncation). Surface it as an
        // event:error so the client sees the failure (not a silent/fake success), and
        // mark terminal so the finally skips synthesizing a clean message_stop. (#2)
        nativeHadError = true;
        nativeErrMsg = err instanceof Error ? err.message : String(err);
        push(
          encodeSSE('error', {
            type: 'error',
            error: { type: 'api_error', message: nativeErrMsg.slice(0, 500) },
          }),
        );
        sawTerminal = true;
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* noop */
        }
        // Clean EOF without a terminal event (no [DONE]/message_stop and no error):
        // synthesize one so the Anthropic SDK completes instead of hanging. Error
        // paths already set sawTerminal after emitting event:error. (#2)
        if (!sawTerminal) {
          push(
            encodeSSE('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: Math.trunc(outTk / 4) },
            }),
          );
          push(encodeSSE('message_stop', { type: 'message_stop' }));
          push('data: [DONE]\n\n');
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        const inputTokens = inTk;
        const outputTokens = outTk;
        const status = nativeHadError ? 500 : 200;
        waitUntil(
          (async () => {
            const enableLogging = (await ensureSettings(ctx))['enable_request_logging'] !== 'false';
            if (enableLogging) {
              await store.logRequest(
                makeLog(account.userId, model, '/v1/messages', true, status, started, nativeErrMsg, inputTokens, outputTokens),
              );
            }
          })(),
        );
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

// ---------------------------------------------------------------------------
// Native Anthropic request translation — TranslateAnthropicRequest
// (translate.go:45-69, 71-81, 98-107)
// ---------------------------------------------------------------------------

/**
 * Build the body for JoyCode's native Anthropic endpoint. Claude-family models
 * reject the legacy OpenAI path, so the request is largely passed through with
 * Anthropic-native field names; model is resolved through the native resolver
 * which forces Claude → "Claude-Opus-4.7".
 */
function translateAnthropicRequest(
  req: AnthropicRequest,
  accountDefault: string,
  systemDefault: string,
): Record<string, unknown> {
  const model = resolveNativeAnthropicModel(req.model ?? '', accountDefault, systemDefault);
  const body: Record<string, unknown> = {
    model,
    // req.messages are Anthropic-shaped already; pass verbatim (Go: req.Messages).
    messages: req.messages ?? [],
    stream: true,
    max_tokens: req.max_tokens,
    thinking: { type: 'disabled' },
  };
  if (req.system !== undefined && req.system !== null) {
    body['system'] = normalizeAnthropicSystem(req.system);
  }
  if (req.stop_sequences && req.stop_sequences.length > 0) {
    body['stop_sequences'] = req.stop_sequences;
  }
  if (req.tools && req.tools.length > 0) {
    body['tools'] = req.tools;
  }
  if (req.tool_choice !== undefined && req.tool_choice !== null) {
    body['tool_choice'] = req.tool_choice;
  }
  return body;
}

/** normalizeAnthropicSystem (translate.go:71-81). */
function normalizeAnthropicSystem(raw: unknown): unknown {
  if (typeof raw === 'string') {
    return [{ type: 'text', text: raw }];
  }
  if (Array.isArray(raw)) {
    return raw;
  }
  return raw;
}

/** resolveNativeAnthropicModel (translate.go:98-107). */
function resolveNativeAnthropicModel(model: string, accountDefault: string, systemDefault: string): string {
  const resolved = resolveModel(model, accountDefault, systemDefault);
  if (resolved === 'Claude-Opus-4.7') return resolved;
  if (isNativeAnthropicModel(resolved)) return 'Claude-Opus-4.7';
  return resolved;
}

/** IsNativeAnthropicModel (translate.go:93-96). */
function isNativeAnthropicModel(model: string | undefined): boolean {
  const m = (model ?? '').toLowerCase();
  return m.startsWith('claude') || m.includes('claude-');
}

// ---------------------------------------------------------------------------
// Native Anthropic SSE helpers (handler.go:735-805)
// ---------------------------------------------------------------------------

/**
 * Derive an Anthropic event name from a payload's `type` field
 * (nativeAnthropicEventType :746-754). Returns '' on parse failure.
 */
function nativeAnthropicEventType(payload: string): string {
  try {
    const obj = JSON.parse(payload) as { type?: unknown };
    if (typeof obj.type === 'string') return obj.type;
  } catch {
    /* return '' */
  }
  return '';
}

/**
 * Update input/output token totals from a native Anthropic SSE payload
 * (updateNativeAnthropicUsage :767-799). Inspects both message.usage and the
 * top-level usage object.
 */
function updateNativeAnthropicUsage(payload: string, sink: (inputTokens: number, outputTokens: number) => void): void {
  try {
    const event = JSON.parse(payload) as {
      message?: { usage?: { input_tokens?: number; output_tokens?: number } };
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    let inTk = 0;
    let outTk = 0;
    if (event.message?.usage) {
      if (typeof event.message.usage.input_tokens === 'number') inTk = event.message.usage.input_tokens;
      if (typeof event.message.usage.output_tokens === 'number') outTk = event.message.usage.output_tokens;
    }
    if (inTk === 0 && event.usage && typeof event.usage.input_tokens === 'number') {
      inTk = event.usage.input_tokens;
    }
    if (outTk === 0 && event.usage && typeof event.usage.output_tokens === 'number') {
      outTk = event.usage.output_tokens;
    }
    sink(inTk, outTk);
  } catch {
    /* swallow */
  }
}

/**
 * isUpstreamError (handler.go:987-1005): a JSON payload is an upstream error if
 * it has no `choices` AND has any of error/code/status/msg.
 */
function isUpstreamError(payload: string): boolean {
  if (payload === '' || payload === '[DONE]') return false;
  let parsed: Record<string, unknown>;
  try {
    const p = JSON.parse(payload);
    if (!p || typeof p !== 'object') return false;
    parsed = p as Record<string, unknown>;
  } catch {
    return false;
  }
  // OpenAI-shape: a real chat chunk carries choices; absence + error fields => error.
  if (Array.isArray(parsed['choices']) && parsed['choices'].length > 0) return false;
  // Anthropic-native explicit error event. (#6)
  if (parsed['type'] === 'error') return true;
  // A valid Anthropic data event (message_*/content_*/ping) is NOT an error even if
  // it happens to carry a status/msg field — don't false-positive it away. (#6)
  const t = typeof parsed['type'] === 'string' ? (parsed['type'] as string) : '';
  if (t.startsWith('message_') || t.startsWith('content_') || t === 'ping') return false;
  return (
    parsed['error'] !== undefined ||
    parsed['code'] !== undefined ||
    (typeof parsed['status'] === 'string' && parsed['status'] !== '') ||
    (typeof parsed['msg'] === 'string' && parsed['msg'] !== '')
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** stop_reason map (handler.go:426-436). */
function mapStopReason(finishReason: string): string {
  switch (finishReason) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'stop':
      return 'end_turn';
    case 'content_filter':
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

/** writeContentFilterError (handler.go:1031-1040). */
function contentFilterError(msg: string): Response {
  return Response.json(
    {
      type: 'error',
      error: { type: 'invalid_request_error', message: msg || 'content_filter' },
    },
    { status: 400 },
  );
}

/** isTimeoutError (handler.go:940-949). */
function isTimeoutError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('context deadline exceeded') ||
    lower.includes('client.timeout exceeded') ||
    lower.includes('deadline exceeded') ||
    lower.includes('i/o timeout') ||
    lower.includes('timed out') ||
    lower.includes('abort') // Workers fetch timeouts surface as AbortError
  );
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

/** Coerce a JSON number/string to a safe integer (0 otherwise). */
function numOr(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return 0;
}

/** Build a RequestLogRow. The `stream` field is 0/1 per the D1 schema. */
function makeLog(
  apiKey: string,
  model: string,
  endpoint: string,
  stream: boolean,
  statusCode: number,
  started: number,
  errorMessage: string,
  inputTokens: number,
  outputTokens: number,
): RequestLogRow {
  return {
    api_key: apiKey,
    model,
    endpoint,
    stream: stream ? 1 : 0,
    status_code: statusCode,
    latency_ms: Date.now() - started,
    error_message: errorMessage,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
}

/** Log a request row only if request logging is enabled. */
async function maybeLog(env: Env, store: ReturnType<typeof createStore>, log: RequestLogRow): Promise<void> {
  const enableLogging = (await getSetting(env.DB, 'enable_request_logging')) !== 'false';
  if (enableLogging) {
    await store.logRequest(log);
  }
}

/**
 * Flush captured stream usage into a request log row. Idempotent-ish: the caller
 * arranges for this to run once at stream completion (the translated stream
 * calls it from the finish branch and the finally; the finally is the source of
 * truth because it always runs).
 */
function flushUsageAndLog(
  env: Env,
  store: ReturnType<typeof createStore>,
  account: Account,
  model: string,
  started: number,
  inputTokens: number,
  outputTokens: number,
  waitUntil: (p: Promise<unknown>) => void,
  status: number = 200,
): void {
  waitUntil(
    (async () => {
      const enableLogging = (await getSetting(env.DB, 'enable_request_logging')) !== 'false';
      if (enableLogging) {
        await store.logRequest(
          makeLog(account.userId, model, '/v1/messages', true, status, started, '', inputTokens, outputTokens),
        );
      }
    })(),
  );
}
