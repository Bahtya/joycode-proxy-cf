// GET /v1/models — OpenAI-compatible model list.
// Ports pkg/openai/handler.go handleModels (lines 100-111).
//
// Go called s.getClient(r).ListModels() and on error returned a 500. Here we
// prefer the upstream list but fall back to the static MODELS catalog
// (src/joycode/models.ts) on error, so the endpoint degrades gracefully on a
// Cloudflare edge timeout rather than hard-failing the client. This is a
// deliberate robustness improvement; flagged in the port report.
import type { Env } from '../../src/types';
import type { V1Data } from './_middleware';
import { jsonError } from '../../src/util/http';
import { createJoyClient } from '../../src/joycode/client';
import { MODELS } from '../../src/joycode/models';
import { translateOpenAIModels } from '../../src/translate/openai';

export const onRequestGet: PagesFunction<Env, string, V1Data> = async ({ env, data }) => {
  const account = data.account;
  if (!account) {
    return jsonError(503, 'no account configured');
  }

  const client = createJoyClient({
    ptKey: account.ptKey,
    userId: account.userId,
    baseURL: env.JOYCODE_BASE_URL,
    clientVersion: env.JOYCODE_CLIENT_VERSION,
  });

  let models: { modelId?: string; label?: string }[];
  try {
    models = await client.listModels();
  } catch {
    // Fallback: synthesize a minimal descriptor list from the static catalog.
    // Each entry uses the model id as both modelId and label.
    models = (MODELS as readonly string[]).map((id) => ({ modelId: id, label: id }));
  }

  return Response.json(translateOpenAIModels(models));
};
