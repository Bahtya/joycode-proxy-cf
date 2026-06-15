// Model catalog + upstream model descriptor shape.
// Ported from pkg/joycode/types.go (ModelInfo) and pkg/joycode/client.go:26-36 (Models).

/**
 * ModelInfo describes a JoyCode AI model.
 *
 * Mirrors the JSON emitted by the upstream `/api/saas/models/v1/modelList`
 * endpoint. Field names are lowerCamelCase as used by the JoyCode API and
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
 * Built-in model allowlist exposed by the proxy dashboard / defaults.
 *
 * Order matters: the first entry is the default model.
 * See pkg/joycode/client.go:26-36.
 */
export const MODELS: readonly string[] = [
  'JoyAI-Code',
  'Claude-Opus-4.7',
  'MiniMax-M2.7',
  'Kimi-K2.6',
  'Kimi-K2.5',
  'GLM-5.1',
  'GLM-5',
  'GLM-4.7',
  'Doubao-Seed-2.0-pro',
] as const;

/** Default model id (MODELS[0]). Matches pkg/joycode/client.go:19. */
export const DEFAULT_MODEL = 'JoyAI-Code';

/**
 * Default selectable-models seed (high-tier subset) used when the
 * `selectable_models` setting is unset. The admin can reconfigure the live list
 * from the Settings page (picking from upstream candidates); this is only the
 * out-of-the-box fallback. NOTE: this is a DISPLAY concern only — MODELS above
 * remains the request-routing allowlist and is intentionally left untouched.
 */
export const DEFAULT_SELECTABLE_MODELS: readonly string[] = [
  'JoyAI-Code-1.5',
  'Claude-Opus-4.7',
  'MiniMax-M2.7',
  'Kimi-K2.6',
  'GLM-5.1',
] as const;
