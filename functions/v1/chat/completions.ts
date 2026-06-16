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
import type { Env, Account, RequestLogRow } from '../../../src/types';
import type { V1Data } from '../_middleware';
import { ensureSettings } from '../_middleware';
import { createStore } from '../../../src/store/d1';
import { readJson, jsonError } from '../../../src/util/http';
import { createJoyClient } from '../../../src/joycode/client';
import { MODELS } from '../../../src/joycode/models';
import {
  translateOpenAIRequest,
  translateOpenAIResponse,
  resolveModel,
  type OpenAIChatRequest,
} from '../../../src/translate/openai';

const CHAT_ENDPOINT = '/api/saas/openai/v1/chat/completions';
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

  let resp: Record<string, unknown>;
  try {
    resp = await client.post(CHAT_ENDPOINT, jcBody);
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
      store.logRequest(makeLog(account.userId, model, '/v1/chat/completions', false, 200, started, '', inputTokens, outputTokens))
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

  let upstream: Response;
  try {
    upstream = await client.postStream(CHAT_ENDPOINT, jcBody);
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
        makeLog(account.userId, model, '/v1/chat/completions', true, 502, started, msg, 0, 0)
      )
    );
    return new Response(errorStream, { headers: SSE_HEADERS });
  }

  const body = upstream.body;
  if (!body) {
    return jsonError(502, 'upstream returned no body');
  }

  const [clientBranch, logBranch] = body.tee();

  // Drain logBranch in the background, parsing usage from the final chunk.
  waitUntil(
    (async () => {
      let inputTokens = 0;
      let outputTokens = 0;
      let lastUsageObj: Record<string, unknown> | null = null;
      const reader = logBranch.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // Process complete SSE events (terminated by \n\n).
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const event = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const usage = parseUsageFromEvent(event);
            if (usage) lastUsageObj = usage;
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) {
          const usage = parseUsageFromEvent(buffer);
          if (usage) lastUsageObj = usage;
        }
      } catch {
        // Swallow: logging is best-effort.
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* noop */
        }
      }
      if (lastUsageObj) {
        inputTokens = numOr(lastUsageObj['prompt_tokens']);
        outputTokens = numOr(lastUsageObj['completion_tokens']);
      }
      const enableLogging = (await ensureSettings(ctx))['enable_request_logging'] !== 'false';
      if (enableLogging) {
        await store.logRequest(
          makeLog(account.userId, model, '/v1/chat/completions', true, 200, started, '', inputTokens, outputTokens)
        );
      }
    })()
  );

  return new Response(clientBranch, { headers: SSE_HEADERS });
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
  outputTokens: number
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
