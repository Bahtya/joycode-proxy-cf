// Shared types for the JoyCodeProxy edge port.

/** Worker bindings, vars and secrets (see wrangler.pages.toml). */
export interface Env {
  DB: D1Database;
  QR_SESSIONS: KVNamespace;
  ASSETS: Fetcher; // Pages static-asset binding (SPA fallback)

  // [vars]
  JOYCODE_BASE_URL: string;
  JOYCODE_CLIENT_VERSION: string;
  MAX_ACCOUNTS: string;
  DEFAULT_TIMEOUT: string;

  // secrets
  PTKEY_ENC_KEY: string; // 64-char hex (32-byte AES-256-GCM key)
  JWT_SECRET: string; // HS256 signing key
  AUTH_PASSWORD_HASH?: string; // optional pre-set bcrypt hash; else created on /setup
}

/** A decrypted account, as used in-memory by the proxy / dashboard. */
export interface Account {
  userId: string;
  nickname: string;
  remark: string;
  apiToken: string;
  ptKey: string; // decrypted JD credential
  isDefault: boolean;
  defaultModel: string;
  createdAt: string;
  updatedAt: string;
  credentialRefreshedAt: string;
  credentialValid: number; // -1 unknown, 0 invalid, 1 valid
  displayOrder: number;
}

/** A stored account row (pt_key still AES-GCM ciphertext hex). */
export interface AccountRow {
  user_id: string;
  nickname: string;
  remark: string;
  api_token: string;
  pt_key: string;
  is_default: number;
  default_model: string;
  created_at: string;
  updated_at: string;
  credential_refreshed_at: string;
  credential_valid: number;
  display_order: number;
}

export interface RequestLogRow {
  id?: number;
  api_key: string;
  model: string;
  endpoint: string;
  client: string;
  user_agent: string;
  stream: number;
  status_code: number;
  latency_ms: number;
  error_message: string;
  input_tokens: number;
  output_tokens: number;
  created_at?: string;
}

export interface KeepaliveStatusRow {
  user_id: string;
  last_checked: string;
  last_refreshed: string;
  status: string;
  message: string;
  updated_at: string;
}

// Settings keys (mirror pkg/store settings used across the Go app).
export const SettingKeys = {
  authPasswordHash: 'auth_password_hash',
  authJwtSecret: 'auth_jwt_secret',
  requestTimeout: 'request_timeout',
  maxConnections: 'max_connections',
  logRetentionDays: 'log_retention_days',
  enableRequestLogging: 'enable_request_logging',
  selectableModels: 'selectable_models',
} as const;

export type SettingKey = (typeof SettingKeys)[keyof typeof SettingKeys];
