// POST /v1/chat/completions — OpenAI-compatible chat proxy.
// Ports pkg/openai/chat.go handleChat / handleNonStreamChat / handleStreamChat.
//
// Differences from Go (serverless):
//   - Account comes from data.account (set by functions/v1/_middleware.ts),
//     not from a per-request resolver closure (chat.go:31 s.getClient(r)).
//   - Model resolution uses ResolveModel with the account default + a global
//     default pulled from settings (chat.go:24-28).
//   - Non-stream: log usage from resp.usage (chat.go:52-56) via store.logRequest.
//   - Stream: tee the upstream SSE body — return one branch to the client with
//     SSE headers (chat.go:66-70), and consume the other branch in waitUntil to
//     parse the final usage chunk and store.logRequest. Go logged via the
//     responseWriter capture in requestLogMiddleware (serve.go:378-433); here we
//     parse usage directly from the stream since we cannot intercept the bytes
//     the client already received.
//   - Timeout detection (isTimeoutError, chat.go:104-110) maps to 504.
import type { Env, Account } from '../../../src/types';
import type { V1Data } from '../_middleware';
import { ensureSettings } from '../_middleware';
import { createStore } from '../../../src/store/d1';
import { readJson, jsonError } from '../../../src/util/http';
import { makeLog } from '../../../src/util/logRow';
import { createJoyClient } from '../../../src/joycode/client';
import { withRetry, parseRetries, EmptyUpstreamError } from '../../../src/proxy/retry';
import { MODELS } from '../../../src/joycode/models';
import {
  translateOpenAIRequest,
  translateOpenAIResponse,
  resolveModel,
  type OpenAIChatRequest,
} from '../../../src/translate/openai';

const CHAT_ENDPOINT = 'chat_completions';
const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
};

export const onRequestPost: PagesFunction<Env, string, V1Data> = async (ctx) => {
  const { request, env, data } = ctx;
  const account = data.account;
  if (!account) {
    // _middleware should have already rejected; defend in depth.
    return jsonError(503, 'no account configured');
  }

  // Parse body (chat.go:18-23). readJson throws a 400 Response on invalid JSON.
  let body: OpenAIChatRequest;
  try {
    body = await readJson<OpenAIChatRequest>(request);
  } catch (e) {
    return e instanceof Response ? e : jsonError(400, 'invalid JSON body');
  }

  const systemDefault = (await ensureSettings(ctx))['default_model'] ?? null;
  const model = resolveModel(
    typeof body.model === 'string' ? body.model : '',
    account.defaultModel ?? '',
    systemDefault ?? '',
    MODELS as readonly string[]
  );

  // Note: the joycode client is constructed inside the stream/non-stream
  // handlers (one per path) rather than here, so a stream request does not pay
  // for a client it never uses. createStore() is similarly deferred.
  const jcBody = translateOpenAIRequest(body);
  const started = Date.now();

  if (body.stream === true) {
    return handleStream(ctx, account, model, jcBody, started);
  }
  return handleNonStream(ctx, account, model, jcBody, started);
};

/** Non-streaming chat. Ports handleNonStreamChat (chat.go:39-58). */
async function handleNonStream(
  ctx: Parameters<PagesFunction<Env, string, V1Data>>[0],
  account: Account,
  model: string,
  jcBody: Record<string, unknown>,
  started: number
): Promise<Response> {
  const { env, waitUntil } = ctx;
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  const client = createJoyClient({
    ptKey: account.ptKey,
    userId: account.userId,
    baseURL: env.JOYCODE_BASE_URL,
    clientVersion: env.JOYCODE_CLIENT_VERSION,
  });

  const maxRetries = parseRetries((await ensureSettings(ctx))['max_retries']);
  let resp: Record<string, unknown>;
  try {
    resp = await withRetry(async () => {
      const r = await client.post(CHAT_ENDPOINT, jcBody);
      if (!r || !Array.isArray(r.choices) || r.choices.length === 0)
        throw new EmptyUpstreamError('no choices in response');
      return r;
    }, maxRetries);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isTimeoutError(msg)) {
      return jsonError(504, `上游服务响应超时，请稍后重试。原始错误: ${msg}`);
    }
    return jsonError(500, msg);
  }

  // Capture usage for logging (chat.go:52-56).
  let inputTokens = 0;
  let outputTokens = 0;
  const usage = resp['usage'] as Record<string, unknown> | undefined;
  if (usage && typeof usage === 'object') {
    inputTokens = numOr(usage['prompt_tokens']);
    outputTokens = numOr(usage['completion_tokens']);
  }

  const enableLogging = (await ensureSettings(ctx))['enable_request_logging'] !== 'false';
  if (enableLogging) {
    waitUntil(
      store.logRequest(makeLog({
        apiKey: account.userId, model, endpoint: '/v1/chat/completions',
        stream: false, statusCode: 200, started, errorMessage: '',
        inputTokens, outputTokens, client: ctx.data.client ?? '', userAgent: ctx.data.userAgent ?? '', tps: 0,
      }))
    );
  }

  return Response.json(translateOpenAIResponse(resp, model));
}

/**
 * Streaming chat. Ports handleStreamChat (chat.go:60-102).
 *
 * The Go server piped the upstream SSE body straight to the client and relied on
 * requestLogMiddleware (serve.go:378-433) to capture usage from a wrapped
 * ResponseWriter. In Workers we cannot re-read the body the client consumes, so
 * we tee() the upstream stream: one branch is returned to the client verbatim
 * (JoyCode SSE is already OpenAI-compatible — chat.go:87), the other is drained
 * in waitUntil, parsing the last `usage`-bearing data chunk before [DONE] for
 * the request log.
 */
async function handleStream(
  ctx: Parameters<PagesFunction<Env, string, V1Data>>[0],
  account: Account,
  model: string,
  jcBody: Record<string, unknown>,
  started: number
): Promise<Response> {
  const { env, waitUntil } = ctx;
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  const client = createJoyClient({
    ptKey: account.ptKey,
    userId: account.userId,
    baseURL: env.JOYCODE_BASE_URL,
    clientVersion: env.JOYCODE_CLIENT_VERSION,
  });

  const maxRetries = parseRetries((await ensureSettings(ctx))['max_retries']);
  let upstream: Response;
  try {
    upstream = await withRetry(async () => {
      const r = await client.postStream(CHAT_ENDPOINT, jcBody);
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('text/event-stream')) {
        const body = await r.text().catch(() => '');
        throw new EmptyUpstreamError(`non-event-stream response (${ct}): ${body.slice(0, 200)}`);
      }
      return r;
    }, maxRetries);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // chat.go:73-83: emit an error chunk then [DONE] on upstream failure.
    const payload = isTimeoutError(msg)
      ? `上游服务响应超时，请稍后重试。原始错误: ${msg}`
      : msg;
    const errorStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encode(`data: ${JSON.stringify({ error: { message: payload } })}\n\n`));
        controller.enqueue(encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    waitUntil(
      store.logRequest(
        makeLog({
          apiKey: account.userId, model, endpoint: '/v1/chat/completions',
          stream: true, statusCode: 502, started, errorMessage: msg,
          inputTokens: 0, outputTokens: 0, client: ctx.data.client ?? '', userAgent: ctx.data.userAgent ?? '', tps: 0,
        })
      )
    );
    return new Response(errorStream, { headers: SSE_HEADERS });
  }

  const body = upstream.body;
  if (!body) {
    return jsonError(502, 'upstream returned no body');
  }

  // Single-pass: read upstream once (upstream-paced), forwarding each chunk to
  // the client and stamping first→last-chunk arrival as data actually arrives.
  // (Previously tee()+a background drain, which read the fully-buffered logBranch
  // in a burst and collapsed the timing window to ~1ms → wildly inflated TPS.)
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let firstChunkMs = 0;
      let lastChunkMs = 0;
      let lastUsageObj: Record<string, unknown> | null = null;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const now = Date.now();
          if (!firstChunkMs) firstChunkMs = now;
          lastChunkMs = now;
          controller.enqueue(value); // forward to client immediately (low TTFT)
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const usage = parseUsageFromEvent(buffer.slice(0, idx));
            buffer = buffer.slice(idx + 2);
            if (usage) lastUsageObj = usage;
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) {
          const usage = parseUsageFromEvent(buffer);
          if (usage) lastUsageObj = usage;
        }
      } catch {
        // best-effort: keep the client response intact
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        try {
          reader.releaseLock();
        } catch {
          /* noop */
        }
        const inputTokens = lastUsageObj ? numOr(lastUsageObj['prompt_tokens']) : 0;
        const outputTokens = lastUsageObj ? numOr(lastUsageObj['completion_tokens']) : 0;
        const genMs = lastChunkMs - firstChunkMs;
        const tps = genMs > 0 && outputTokens > 0 ? outputTokens / (genMs / 1000) : 0;
        const enableLogging = (await ensureSettings(ctx))['enable_request_logging'] !== 'false';
        if (enableLogging) {
          waitUntil(
            store.logRequest(
              makeLog({
                apiKey: account.userId, model, endpoint: '/v1/chat/completions',
                stream: true, statusCode: 200, started, errorMessage: '',
                inputTokens, outputTokens, client: ctx.data.client ?? '', userAgent: ctx.data.userAgent ?? '', tps,
              })
            )
          );
        }
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

/**
 * Extract a usage object from one SSE event block, if present.
 * An event is one or more `data: ...` lines. JoyCode/OpenAI streams emit a
 * final chunk whose `usage` field carries prompt/completion token totals.
 */
function parseUsageFromEvent(event: string): Record<string, unknown> | null {
  // Only inspect `data:` lines.
  const dataLines = event
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim());
  for (const line of dataLines) {
    if (!line || line === '[DONE]') continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const usage = obj['usage'];
      if (usage && typeof usage === 'object') {
        return usage as Record<string, unknown>;
      }
    } catch {
      // Mirrors Go's json.Unmarshal swallow (translate.go:87-89).
    }
  }
  return null;
}

/** Coerce a JSON number (possibly bigint-ish) to a safe integer. */
function numOr(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return 0;
}

/** Timeout detection. Ports isTimeoutError (chat.go:104-110). */
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

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
