// JoyCode upstream client — stateless HTTP wrapper over the JoyCode color gateway
// (api-ai.jd.com, HMAC-SHA256 signed URLs).
//
// JoyCode IDE 2.7.5 (2026-06-17) migrated all authenticated endpoints off the
// legacy joycode-api.jd.com to the signed color gateway; the legacy host returns
// empty 200s now. Every call goes to `${base}/api?appid=joycode_ide&functionId=…&t=…&sign=…`
// with ptKey + loginType=PIN_JD_CLOUD headers and a clean OpenAI body (no
// tenant/userId/client envelope). Signing lives in ./colorgw.
//
// Runtime notes: Workers fetch() auto-decompresses gzip/deflate/br, so there is
// no manual gzip handling. AbortSignal.timeout is feature-detected for the
// per-request timeout; otherwise the request is unbounded (platform limits apply).

import { signedColorUrl, colorHeaders, FN_USER_INFO, FN_MODEL_LIST } from './colorgw';
import type { ModelInfo } from './models';

/** Options for createJoyClient. */
export interface JoyCodeClientOptions {
  ptKey: string;
  userId: string;
  baseURL: string; // color gateway base, e.g. https://api-ai.jd.com
  clientVersion: string;
  /** Request timeout in seconds. Default 1800 (30 min). */
  timeoutSec?: number;
}

/**
 * Stateless JoyCode upstream client. Every method issues a fresh signed fetch()
 * — no connection pooling state. sessionId is generated once per client instance
 * (kept for parity/traceability, though the color gateway body no longer
 * requires it).
 */
export interface JoyCodeClient {
  /** POST a chat-completions function (functionId), parse JSON, throw on non-200. */
  post(functionId: string, body: Record<string, unknown>): Promise<any>;
  /** POST a chat function and return the upstream streaming Response (already 200). */
  postStream(functionId: string, body: Record<string, unknown>): Promise<Response>;
  listModels(): Promise<ModelInfo[]>;
  userInfo(): Promise<any>;
  /** Returns the refreshed ptKey from the userInfo data, or '' if absent. */
  userInfoWithRefresh(): Promise<string>;
  /** Deprecated — web-search/rerank functionIds are unknown post color-gateway migration. */
  webSearch(query: string): Promise<any[]>;
  rerank(query: string, documents: string[], topN: number): Promise<any>;
}

/** Truncate a string to maxLen chars, appending "..." if truncated. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '...';
}

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
 * Inject the fields the color gateway expects on a chat body:
 * stream_options.include_usage (so usage is returned) and thinking=disabled
 * unless the caller already set it. Mirrors cpa-plugin-joycode injectPayloadFields.
 */
function injectChatFields(body: Record<string, unknown>): Record<string, unknown> {
  body['stream_options'] = { include_usage: true };
  if (body['thinking'] === undefined) body['thinking'] = { type: 'disabled' };
  return body;
}

/** Create a JoyCode upstream client (color gateway). */
export function createJoyClient(opts: JoyCodeClientOptions): JoyCodeClient {
  const ptKey = opts.ptKey;
  const baseURL = opts.baseURL;
  const timeoutSec = opts.timeoutSec ?? 1800;

  // --- Low-level signed POST/GET ---

  async function doFetch(functionId: string, body: string, method: 'POST' | 'GET' = 'POST'): Promise<Response> {
    const url = await signedColorUrl(baseURL, functionId);
    const init: RequestInit = { method, headers: colorHeaders(ptKey) };
    if (method !== 'GET') init.body = body;
    const signal = timeoutSignal(timeoutSec);
    if (signal) init.signal = signal;
    return fetch(url, init);
  }

  // --- Public API ---

  /** Chat: inject stream_options/thinking, POST, parse JSON, throw on non-200. */
  async function post(functionId: string, extra: Record<string, unknown>): Promise<any> {
    const body = JSON.stringify(injectChatFields({ ...extra }));
    const res = await doFetch(functionId, body, 'POST');
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

  /** Chat streaming: inject, POST, return the streaming Response (throws on non-200). */
  async function postStream(functionId: string, extra: Record<string, unknown>): Promise<Response> {
    const body = JSON.stringify(injectChatFields({ ...extra }));
    const res = await doFetch(functionId, body, 'POST');
    if (res.status !== 200) {
      const text = await res.text().catch(() => '');
      throw new Error(`API error ${res.status}: ${truncate(text, 500)}`);
    }
    return res;
  }

  /** List models via joycode_modelList. Parses resp.data into ModelInfo[]. */
  async function listModels(): Promise<ModelInfo[]> {
    const res = await doFetch(FN_MODEL_LIST, '{}', 'POST');
    const text = await res.text();
    if (res.status !== 200) {
      throw new Error(`API error ${res.status}: ${truncate(text, 500)}`);
    }
    let resp: any;
    try {
      resp = JSON.parse(text);
    } catch (err) {
      throw new Error(`invalid JSON response (parse error: ${err instanceof Error ? err.message : String(err)})`);
    }
    const data = resp?.data;
    if (!Array.isArray(data)) {
      throw new Error('unexpected models response format: missing data array');
    }
    const models: ModelInfo[] = [];
    for (const item of data) {
      if (item == null || typeof item !== 'object') continue;
      models.push(coerceModelInfo(item as Record<string, unknown>));
    }
    return models;
  }

  /** Fetch user info via joycode_userInfo (GET). */
  async function userInfo(): Promise<any> {
    const res = await doFetch(FN_USER_INFO, '{}', 'GET');
    const text = await res.text();
    if (res.status !== 200) {
      throw new Error(`API error ${res.status}: ${truncate(text, 500)}`);
    }
    return JSON.parse(text);
  }

  /** userInfo, then return data.ptKey if non-empty else ''. */
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
    listModels,
    userInfo,
    userInfoWithRefresh,
    // web-search/rerank have no known color-gateway functionIds yet — fail loudly.
    webSearch: async () => {
      throw new Error('web-search not migrated to color gateway');
    },
    rerank: async () => {
      throw new Error('rerank not migrated to color gateway');
    },
  };
}

/**
 * Coerce a loosely-typed upstream model object into a ModelInfo with sane
 * defaults for missing/typed-wrong fields.
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
