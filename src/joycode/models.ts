// Model catalog + upstream model descriptor shape.
// Ported from pkg/joycode/types.go (ModelInfo) and pkg/joycode/client.go:26-36 (Models).

/**
 * ModelInfo describes a JoyCode AI model.
 *
 * Mirrors the JSON emitted by the upstream color gateway
 * (functionId=joycode_modelList). Field names are lowerCamelCase as used by the JoyCode API and
 * must NOT be changed (Go types.go tags are the source of truth).
 *
 * See pkg/joycode/types.go:3-15.
 */
export interface ModelInfo {
  label: string;
  chatApiModel: string;
  maxTotalTokens: number;
  respMaxTokens: number;
  temperature: number;
  features: string[];
  supportStream: boolean;
  verificationStatus: string;
  modelId: string;
  createTime: number;
}

/**
 * Request-routing model allowlist used by resolveModel: the client-specified model
 * must be in this list to pass through, otherwise resolveModel falls back to the
 * account/system default.
 *
 * Synced to the live upstream catalog (verified via joycode_modelList functionId):
 * JoyAI-Code-1.5 is the current flagship (replaces the stale 'JoyAI-Code');
 * Kimi-K2.5 and GLM-4.7 have been retired upstream. Order matters — MODELS[0] is
 * the final fallback default. (C1)
 *
 * NOTE: independent of the admin-configured *display* list (settings.selectable_models
 * / DEFAULT_SELECTABLE_MODELS below), which only controls which models appear in
 * dashboard dropdowns, not request routing.
 */
export const MODELS: readonly string[] = [
  'JoyAI-Code-1.5',
  'MiniMax-M2.7',
  'Kimi-K2.6',
  'GLM-5.1',
  'GLM-5',
  'Doubao-Seed-2.0-pro',
] as const;

/** Default model id (MODELS[0]). Matches the current upstream flagship. (C1) */
export const DEFAULT_MODEL = 'JoyAI-Code-1.5';

/**
 * Default selectable-models seed (high-tier subset) used when the
 * `selectable_models` setting is unset. The admin can reconfigure the live list
 * from the Settings page (picking from upstream candidates); this is only the
 * out-of-the-box fallback. NOTE: this is a DISPLAY concern only — MODELS above
 * remains the request-routing allowlist and is intentionally left untouched.
 */
export const DEFAULT_SELECTABLE_MODELS: readonly string[] = [
  'JoyAI-Code-1.5',
  'MiniMax-M2.7',
  'Kimi-K2.6',
  'GLM-5.1',
] as const;
