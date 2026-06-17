// Shared builder for a request-log row. /v1/messages and /v1/chat/completions
// construct RequestLogRow identically; centralizing it keeps the two handlers
// from drifting (they previously held duplicated copies) and the object
// parameter makes call sites name their fields — adjacent same-typed positional
// args (inputTokens/outputTokens, client/userAgent) compiled silently if swapped.

import type { RequestLogRow } from '../types';

export interface MakeLogOptions {
  apiKey: string;
  model: string;
  endpoint: string;
  stream: boolean;
  statusCode: number;
  started: number;
  errorMessage: string;
  inputTokens: number;
  outputTokens: number;
  client: string;
  userAgent: string;
  /** Output tokens/sec for stream requests (first→last chunk span); 0 otherwise. */
  tps: number;
}

/** Build a RequestLogRow. `stream` is stored as 0/1 per the D1 schema. */
export function makeLog(o: MakeLogOptions): RequestLogRow {
  return {
    api_key: o.apiKey,
    model: o.model,
    endpoint: o.endpoint,
    client: o.client,
    user_agent: o.userAgent,
    stream: o.stream ? 1 : 0,
    status_code: o.statusCode,
    latency_ms: Date.now() - o.started,
    error_message: o.errorMessage,
    input_tokens: o.inputTokens,
    output_tokens: o.outputTokens,
    tps: o.tps,
  };
}
