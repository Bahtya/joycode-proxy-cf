// POST /api/accounts/<userId>/diagnose
//
// Validation + diagnostics from the LLM endpoint all the way to upstream, for the
// account modal. Runs three timed steps — credential (userInfo), model list, and a
// minimal real upstream chat probe (max_tokens:1) — each in its own try/catch, and
// returns a structured result the frontend renders and can copy as a diagnostic
// blob. The credential step also persists credential_valid + credential_refreshed_at.
// Uses a short 15s timeout so a stuck probe doesn't hang the UI.
import type { Env } from '../../../../src/types';
import { createStore } from '../../../../src/store/d1';
import { createJoyClient } from '../../../../src/joycode/client';
import { userIdParam } from '../../../../src/dashboard/account-views';
import { notFound } from '../../../../src/util/http';

const CHAT_ENDPOINT = 'chat_completions';
const PROBE_TIMEOUT_SEC = 15;

interface DiagStep {
  key: string;
  label: string;
  ok: boolean;
  latency_ms: number;
  detail?: string;
  [k: string]: unknown;
}

export const onRequestPost: PagesFunction<Env> = async ({ env, params }) => {
  const userId = userIdParam(params);
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  const account = await store.getAccount(userId);
  if (!account) return notFound('account not found');

  const client = createJoyClient({
    ptKey: account.ptKey,
    userId: account.userId,
    baseURL: env.JOYCODE_BASE_URL,
    clientVersion: env.JOYCODE_CLIENT_VERSION,
    timeoutSec: PROBE_TIMEOUT_SEC,
  });

  const steps: DiagStep[] = [];

  // 1) Credential — call userInfo() directly to retain code/msg on failure.
  const t0 = Date.now();
  let credOk = false;
  const credFields: Record<string, unknown> = {};
  try {
    const info = await client.userInfo();
    const code = info?.code;
    if (typeof code === 'number' && code === 0) {
      credOk = true;
      credFields.code = code;
      if (info?.data?.userId) credFields.user_id = info.data.userId;
    } else {
      const msg = typeof info?.msg === 'string' ? info.msg : '';
      credFields.code = code;
      if (msg) credFields.msg = msg;
      credFields.detail = `code=${code}: ${msg || 'unknown error'}`;
    }
  } catch (e) {
    credFields.detail = e instanceof Error ? e.message : String(e);
  }
  const credLatency = Date.now() - t0;
  try {
    await store.setCredentialValid(userId, credOk ? 1 : 0);
    if (credOk) await store.updateCredentialRefreshedAt(userId);
  } catch {
    /* best-effort persist — don't let a DB write flip the result */
  }
  steps.push({ key: 'credential', label: '凭证验证', ok: credOk, latency_ms: credLatency, ...credFields });

  // 2) Models
  const t1 = Date.now();
  let modelIds: string[] = [];
  try {
    const list = await client.listModels();
    // The id may live in `label` rather than `modelId` (translateOpenAIModels uses
    // modelId || label); mirror that so the count and probe-model selection are correct.
    modelIds = list.map((m) => m.modelId || m.label || '').filter((id) => id !== '');
    steps.push({
      key: 'models',
      label: '模型列表',
      ok: true,
      latency_ms: Date.now() - t1,
      count: modelIds.length,
      sample: modelIds.slice(0, 8),
    });
  } catch (e) {
    steps.push({ key: 'models', label: '模型列表', ok: false, latency_ms: Date.now() - t1, detail: e instanceof Error ? e.message : String(e) });
  }

  // 3) Chat probe (LLM endpoint -> upstream). Prefer the account's default_model when
  //    upstream actually lists it, else the first available upstream model, else the flagship.
  const probeModel =
    account.defaultModel && account.defaultModel !== '' && modelIds.includes(account.defaultModel)
      ? account.defaultModel
      : modelIds[0] ?? 'JoyAI-Code-1.5';
  const t2 = Date.now();
  try {
    const resp = await client.post(CHAT_ENDPOINT, {
      model: probeModel,
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    });
    const usage = resp?.usage;
    steps.push({
      key: 'chat',
      label: 'LLM 端点→上游',
      ok: true,
      latency_ms: Date.now() - t2,
      model: probeModel,
      prompt_tokens: usage?.prompt_tokens,
      completion_tokens: usage?.completion_tokens,
      finish_reason: resp?.choices?.[0]?.finish_reason,
    });
  } catch (e) {
    steps.push({
      key: 'chat',
      label: 'LLM 端点→上游',
      ok: false,
      latency_ms: Date.now() - t2,
      model: probeModel,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  return Response.json({
    account: {
      user_id: account.userId,
      nickname: account.nickname,
      default_model: account.defaultModel,
      credential_valid: credOk ? 1 : 0,
    },
    steps,
    timestamp: new Date().toISOString(),
  });
};
