// Typed settings get/set over D1 (mirror of the Go `settings` table usage).
import type { SettingKey } from '../types';
import { DEFAULT_SELECTABLE_MODELS } from '../joycode/models';

const DEFAULTS: Partial<Record<SettingKey, string>> = {
  request_timeout: '1800',
  max_connections: '20',
  log_retention_days: '30',
  enable_request_logging: 'true',
  tz_offset: '8',
};

export async function getSetting(db: D1Database, key: SettingKey | string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: SettingKey | string, value: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    )
    .bind(key, value)
    .run();
}

export async function getIntSetting(db: D1Database, key: SettingKey, fallback: number): Promise<number> {
  const v = await getSetting(db, key);
  if (v == null || v === '') {
    return DEFAULTS[key] != null ? parseInt(DEFAULTS[key] as string, 10) : fallback;
  }
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export async function getBoolSetting(db: D1Database, key: SettingKey, fallbackDefault: string): Promise<string> {
  const v = await getSetting(db, key);
  if (v == null) return DEFAULTS[key] ?? fallbackDefault;
  return v;
}

/**
 * Read the admin-configured selectable model list (settings.selectable_models,
 * stored as a JSON string array). Falls back to DEFAULT_SELECTABLE_MODELS when
 * unset, empty, or malformed. Display-only — does not affect request routing.
 */
export async function getModelList(db: D1Database): Promise<string[]> {
  const raw = await getSetting(db, 'selectable_models');
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
        return parsed.length > 0 ? parsed : [...DEFAULT_SELECTABLE_MODELS];
      }
    } catch {
      // fall through to default seed
    }
  }
  return [...DEFAULT_SELECTABLE_MODELS];
}
