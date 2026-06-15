// JoyCode upstream client — stateless HTTP wrapper over the JoyCode SaaS API.
// Ported from pkg/joycode/client.go.
//
// Key runtime differences vs Go (see "DEVIATIONS" in the port report):
//  - Workers fetch() auto-decompresses gzip/deflate/br, so there is NO manual
//    gzip handling (Go needed decodeBody/decodeStreamBody, lines 186-211).
//  - Workers fetch() has no per-request timeout dial. We pass AbortSignal.timeout
//    when available; otherwise the request is unbounded (the platform enforces
//    its own wall-clock/CPU limits). Go used http.Client{Timeout: 30m}.

import { hexId } from '../util/id';
import { anthropicHeaders, openaiHeaders } from './headers';
import { prepareAnthropicBody, prepareBody } from './envelope';
import type { ModelInfo } from './models';

/** Options for createJoyClient. */
export interface JoyCodeClientOptions {
  ptKey: string;
  userId: string;
  /** Optional override ptKey used only for Anthropic-native calls. */
  anthropicPtKey?: string;
  baseURL: string; // e.g. https://joycode-api.jd.com
  saasBaseURL: string; // e.g. http://joycode-api-saas.jd.com
  clientVersion: string;
  /** Request timeout in seconds. Default 1800 (30 min, matching Go). */
  timeoutSec?: number;
}

/**
 * Stateless JoyCode upstream client.
 *
 * Matches the JoyCodeClient contract from FOUNDATION. Every method issues a
 * fresh fetch() — no connection pooling state is held. The only per-instance
 * state is `sessionId` (generated once in the closure, like Go's NewClient,
 * client.go:65) and the credential/config fields.
 */
export interface JoyCodeClient {
  /** POST JSON, parse JSON response, throw on non-200. */
  post(endpoint: string, body: Record<string, unknown>): Promise<any>;
  /** POST and return the upstream streaming Response (already 200). */
  postStream(endpoint: string, body: Record<string, unknown>): Promise<Response>;
  /** POST (Anthropic headers/body/endpoint) and return the streaming Response. */
  postAnthropicStream(endpoint: string, body: Record<string, unknown>): Promise<Response>;
  listModels(): Promise<ModelInfo[]>;
  webSearch(query: string): Promise<any[]>;
  rerank(query: string, documents: string[], topN: number): Promise<any>;
  userInfo(): Promise<any>;
  /** Returns the refreshed ptKey from the userInfo data, or '' if absent. */
  userInfoWithRefresh(): Promise<string>;
  /** Throws if the credential is invalid (userInfo code !== 0). */
  validate(): Promise<void>;
}

/** Truncate a string to maxLen chars, appending "..." if truncated. See client.go:363-368. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '...';
}

/**
 * Build an AbortSignal with a timeout, if the platform supports it.
 * Workers supports AbortSignal.timeout on recent runtimes; we feature-detect so
 * older runtimes simply run unbounded rather than throw at construction.
 */
function timeoutSignal(timeoutSec: number): AbortSignal | undefined {
  const ms = timeoutSec * 1000;
  const anyAbort = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
  if (typeof anyAbort.timeout === 'function') {
    try {
      return anyAbort.timeout(ms);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Create a JoyCode upstream client. Mirrors Go's NewClient (client.go:61-68):
 * sessionId is generated ONCE per client instance and reused across calls.
 */
export function createJoyClient(opts: JoyCodeClientOptions): JoyCodeClient {
  const ptKey = opts.ptKey;
  const anthropicPtKey = opts.anthropicPtKey ?? '';
  const userId = opts.userId;
  const baseURL = opts.baseURL;
  const saasBaseURL = opts.saasBaseURL;
  const clientVersion = opts.clientVersion;
  const timeoutSec = opts.timeoutSec ?? 1800;

  // sessionId is per-client-once (Go: client.go:65). chatId/requestId are per-call.
  const sessionId = hexId();

  // --- Low-level POST helpers (mirror doPost/doAnthropicPost, client.go:156-184) ---

  async function doPost(endpoint: string, body: Record<string, unknown>): Promise<Response> {
    const url = baseURL + endpoint;
    const init: RequestInit = {
      method: 'POST',
      headers: openaiHeaders(ptKey),
      body: JSON.stringify(body),
    };
    const signal = timeoutSignal(timeoutSec);
    if (signal) init.signal = signal;
    return fetch(url, init);
  }

  async function doAnthropicPost(endpoint: string, body: Record<string, unknown>): Promise<Response> {
    const url = saasBaseURL + endpoint;
    const init: RequestInit = {
      method: 'POST',
      headers: anthropicHeaders(ptKey, anthropicPtKey),
      body: JSON.stringify(body),
    };
    const signal = timeoutSignal(timeoutSec);
    if (signal) init.signal = signal;
    return fetch(url, init);
  }

  // --- Public API ---

  /** POST → parsed JSON. Throws Error("API error {status}: {body}") on non-200 (client.go:213-234). */
  async function post(endpoint: string, extra: Record<string, unknown>): Promise<any> {
    const body = prepareBody(userId, sessionId, extra);
    const res = await doPost(endpoint, body);
    // fetch() already decompressed the body; read as text then JSON-parse.
    const text = await res.text();
    if (res.status !== 200) {
      throw new Error(`API error ${res.status}: ${truncate(text, 500)}`);
    }
    let result: any;
    try {
      result = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `invalid JSON response (parse error: ${err instanceof Error ? err.message : String(err)}): ${truncate(text, 500)}`,
      );
    }
    return result;
  }

  /**
   * POST → return the streaming Response directly. On non-200 read the body and
   * throw. The returned Response body is a ReadableStream the caller must
   * consume/forward. (client.go:236-253)
   *
   * We deliberately do NOT read/decode the body on success — Workers streams it.
   */
  async function postStream(endpoint: string, extra: Record<string, unknown>): Promise<Response> {
    const body = prepareBody(userId, sessionId, extra);
    const res = await doPost(endpoint, body);
    if (res.status !== 200) {
      const text = await res.text().catch(() => '');
      throw new Error(`API error ${res.status}: ${truncate(text, 500)}`);
    }
    return res;
  }

  /** Anthropic-native streaming POST. (client.go:255-272) */
  async function postAnthropicStream(
    endpoint: string,
    extra: Record<string, unknown>,
  ): Promise<Response> {
    const body = prepareAnthropicBody(userId, extra);
    const res = await doAnthropicPost(endpoint, body);
    if (res.status !== 200) {
      const text = await res.text().catch(() => '');
      throw new Error(`API error ${res.status}: ${truncate(text, 500)}`);
    }
    return res;
  }

  /** List models. Parses resp.data into ModelInfo[], skipping malformed entries (client.go:274-296). */
  async function listModels(): Promise<ModelInfo[]> {
    const resp = await post('/api/saas/models/v1/modelList', {});
    const data = resp?.data;
    if (!Array.isArray(data)) {
      throw new Error('unexpected models response format: missing data array');
    }
    const models: ModelInfo[] = [];
    for (const item of data) {
      if (item == null || typeof item !== 'object') continue;
      // Go re-marshals then unmarshals to coerce; in TS we just validate+cast.
      const m = item as Record<string, unknown>;
      models.push(coerceModelInfo(m));
    }
    return models;
  }

  /** Web search. Returns resp.search_result (array, possibly empty). (client.go:298-309) */
  async function webSearch(query: string): Promise<any[]> {
    const resp = await post('/api/saas/openai/v1/web-search', {
      messages: [{ role: 'user', content: query }],
      stream: false,
      model: 'search_pro_jina',
      language: 'UNKNOWN',
    });
    const results = resp?.search_result;
    return Array.isArray(results) ? results : [];
  }

  /** Rerank documents. (client.go:311-316) */
  async function rerank(query: string, documents: string[], topN: number): Promise<any> {
    return post('/api/saas/openai/v1/rerank', {
      model: 'Qwen3-Reranker-8B',
      query,
      documents,
      top_n: topN,
    });
  }

  /** Fetch user info. (client.go:318-320) */
  async function userInfo(): Promise<any> {
    return post('/api/saas/user/v1/userInfo', {});
  }

  /**
   * Validate credential: userInfo must return code===0. (client.go:322-336)
   * Throws on transport error or non-zero code.
   */
  async function validate(): Promise<void> {
    const resp = await userInfo().catch((err: unknown) => {
      throw new Error(`credential validation failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    const code = resp?.code;
    if (typeof code !== 'number' || code !== 0) {
      const msg = typeof resp?.msg === 'string' && resp.msg !== '' ? resp.msg : 'unknown error';
      const codeStr = typeof code === 'number' ? Math.round(code).toString() : String(code ?? '');
      throw new Error(`credential validation failed (code=${codeStr}): ${msg}`);
    }
  }

  /**
   * userInfo, then return data.ptKey if non-empty else ''. (client.go:338-361)
   * Throws on transport error or non-zero code (matches Go).
   */
  async function userInfoWithRefresh(): Promise<string> {
    const resp = await userInfo().catch((err: unknown) => {
      throw new Error(`user info request failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    const code = resp?.code;
    if (typeof code !== 'number' || code !== 0) {
      const msg = typeof resp?.msg === 'string' && resp.msg !== '' ? resp.msg : 'unknown error';
      const codeStr = typeof code === 'number' ? Math.round(code).toString() : String(code ?? '');
      throw new Error(`user info failed (code=${codeStr}): ${msg}`);
    }
    const data = resp?.data;
    if (data == null || typeof data !== 'object') return '';
    const pt = (data as Record<string, unknown>).ptKey;
    return typeof pt === 'string' && pt !== '' ? pt : '';
  }

  return {
    post,
    postStream,
    postAnthropicStream,
    listModels,
    webSearch,
    rerank,
    userInfo,
    userInfoWithRefresh,
    validate,
  };
}

/**
 * Coerce a loosely-typed upstream model object into a ModelInfo with sane
 * defaults for missing/typed-wrong fields. Go achieves the same via
 * json.Unmarshal into a typed struct (which zeroes missing fields); we mirror
 * that zero-value behavior here.
 */
function coerceModelInfo(m: Record<string, unknown>): ModelInfo {
  return {
    label: typeof m.label === 'string' ? m.label : '',
    chatApiModel: typeof m.chatApiModel === 'string' ? m.chatApiModel : '',
    maxTotalTokens: typeof m.maxTotalTokens === 'number' ? m.maxTotalTokens : 0,
    respMaxTokens: typeof m.respMaxTokens === 'number' ? m.respMaxTokens : 0,
    temperature: typeof m.temperature === 'number' ? m.temperature : 0,
    features: Array.isArray(m.features) ? (m.features as unknown[]).filter((f): f is string => typeof f === 'string') : [],
    supportStream: typeof m.supportStream === 'boolean' ? m.supportStream : false,
    verificationStatus: typeof m.verificationStatus === 'string' ? m.verificationStatus : '',
    modelId: typeof m.modelId === 'string' ? m.modelId : '',
    createTime: typeof m.createTime === 'number' ? m.createTime : 0,
  };
}

// Re-export shared constants so callers can import everything from the client module.
export { CLIENT_VERSION, USER_AGENT } from './headers';
export { MODELS, DEFAULT_MODEL, type ModelInfo } from './models';
