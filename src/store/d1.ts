// D1-backed store: accounts, keepalive, request logs.
// Ports pkg/store/store.go account CRUD + keepalive helpers + LogRequest.
import type { Account, AccountRow, RequestLogRow, KeepaliveStatusRow, AvailabilitySample } from '../types';
import { encrypt, decrypt } from './crypto';
import { hexId } from '../util/id';

/**
 * Raw per-request logs are kept for this many days for fine-grained views
 * (24h hourly chart, recent-logs list, today). Days older than this are rolled
 * up into `stats_daily` and their raw rows deleted (see Store.rollupLogs), so
 * long-range queries read the compact rollup instead of the full raw table.
 */
export const RAW_LIVE_WINDOW_DAYS = 7;

export class Store {
  constructor(private db: D1Database, private encKey: string) {}

  private async rowToAccount(r: AccountRow): Promise<Account> {
    return {
      userId: r.user_id,
      nickname: r.nickname,
      remark: r.remark,
      apiToken: r.api_token,
      ptKey: await this.decryptPtKey(r.pt_key),
      isDefault: r.is_default === 1,
      defaultModel: r.default_model,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      credentialRefreshedAt: r.credential_refreshed_at,
      credentialValid: r.credential_valid,
      displayOrder: r.display_order,
    };
  }

  private async decryptPtKey(cipherHex: string): Promise<string> {
    try {
      return await decrypt(cipherHex, this.encKey);
    } catch {
      return '';
    }
  }

  // --- Account reads ---

  async getAccount(userId: string): Promise<Account | null> {
    const r = await this.db.prepare('SELECT * FROM accounts WHERE user_id = ?').bind(userId).first<AccountRow>();
    return r ? this.rowToAccount(r) : null;
  }

  async getAccountByToken(token: string): Promise<Account | null> {
    const r = await this.db
      .prepare('SELECT * FROM accounts WHERE api_token = ? LIMIT 1')
      .bind(token)
      .first<AccountRow>();
    return r ? this.rowToAccount(r) : null;
  }

  async getDefaultAccount(): Promise<Account | null> {
    const r = await this.db
      .prepare('SELECT * FROM accounts WHERE is_default = 1 LIMIT 1')
      .first<AccountRow>();
    return r ? this.rowToAccount(r) : null;
  }

  async listAccounts(): Promise<Account[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM accounts ORDER BY display_order ASC, created_at ASC')
      .all<AccountRow>();
    return Promise.all(results.map((r) => this.rowToAccount(r)));
  }

  async countAccounts(): Promise<number> {
    const r = await this.db.prepare('SELECT COUNT(*) AS n FROM accounts').first<{ n: number }>();
    return r?.n ?? 0;
  }

  // --- Account writes ---

  async addAccount(a: {
    userId: string;
    nickname?: string;
    remark?: string;
    apiToken?: string;
    ptKey: string;
    isDefault?: boolean;
    defaultModel?: string;
  }): Promise<Account> {
    const ptCipher = await encrypt(a.ptKey, this.encKey);
    const isDefault = a.isDefault ? 1 : 0;
    // Match Go store.go:592 — always provision an api_token (sk-<32hex>) when the
    // caller didn't supply one, so every account has a usable proxy key.
    const apiToken =
      a.apiToken && a.apiToken.trim() !== '' ? a.apiToken : 'sk-' + hexId(16);
    if (isDefault) await this.db.prepare('UPDATE accounts SET is_default = 0').run();
    await this.db
      .prepare(
        `INSERT INTO accounts
          (user_id, nickname, remark, api_token, pt_key, is_default, default_model, created_at, updated_at, credential_refreshed_at, credential_valid, display_order)
         VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now'),'',-1,
           COALESCE((SELECT MAX(display_order) FROM accounts), -1) + 1)`
      )
      .bind(
        a.userId,
        a.nickname ?? '',
        a.remark ?? '',
        apiToken,
        ptCipher,
        isDefault,
        a.defaultModel ?? ''
      )
      .run();
    const created = await this.getAccount(a.userId);
    if (!created) throw new Error('addAccount: insert failed');
    return created;
  }

  async updatePtKey(userId: string, newPtKey: string): Promise<void> {
    const ptCipher = await encrypt(newPtKey, this.encKey);
    await this.db
      .prepare("UPDATE accounts SET pt_key = ?, updated_at = datetime('now') WHERE user_id = ?")
      .bind(ptCipher, userId)
      .run();
  }

  async setCredentialValid(userId: string, valid: number): Promise<void> {
    await this.db
      .prepare("UPDATE accounts SET credential_valid = ?, updated_at = datetime('now') WHERE user_id = ?")
      .bind(valid, userId)
      .run();
  }

  async updateCredentialRefreshedAt(userId: string, when: string = ''): Promise<void> {
    const ts = when || new Date().toISOString().replace('T', ' ').substring(0, 19);
    await this.db
      .prepare("UPDATE accounts SET credential_refreshed_at = ?, updated_at = datetime('now') WHERE user_id = ?")
      .bind(ts, userId)
      .run();
  }

  async setDefault(userId: string): Promise<void> {
    await this.db.batch([
      this.db.prepare('UPDATE accounts SET is_default = 0'),
      this.db.prepare("UPDATE accounts SET is_default = 1, updated_at = datetime('now') WHERE user_id = ?").bind(userId),
    ]);
  }

  async updateRemark(userId: string, remark: string): Promise<void> {
    await this.db
      .prepare("UPDATE accounts SET remark = ?, updated_at = datetime('now') WHERE user_id = ?")
      .bind(remark, userId)
      .run();
  }

  async setDefaultModel(userId: string, model: string): Promise<void> {
    await this.db
      .prepare("UPDATE accounts SET default_model = ?, updated_at = datetime('now') WHERE user_id = ?")
      .bind(model, userId)
      .run();
  }

  async deleteAccount(userId: string): Promise<void> {
    await this.db.prepare('DELETE FROM accounts WHERE user_id = ?').bind(userId).run();
  }

  async clearAllAccounts(): Promise<void> {
    await this.db.prepare('DELETE FROM accounts').run();
  }

  async reorder(userIds: string[]): Promise<void> {
    const stmts = userIds.map((uid, i) =>
      this.db.prepare('UPDATE accounts SET display_order = ? WHERE user_id = ?').bind(i, uid)
    );
    await this.db.batch(stmts);
  }

  // --- Keepalive ---

  /** Accounts whose pt_key is stale (never refreshed or older than ttlHours), for the cron. */
  async listStaleAccounts(ttlHours = 1): Promise<Account[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM accounts
         WHERE credential_valid = 0
            OR credential_refreshed_at = ''
            OR datetime(credential_refreshed_at) < datetime('now', ?)`
      )
      .bind(`-${ttlHours} hours`)
      .all<AccountRow>();
    return Promise.all(results.map((r) => this.rowToAccount(r)));
  }

  async setKeepaliveStatus(
    userId: string,
    status: { lastChecked?: string; lastRefreshed?: string; status: string; message?: string }
  ): Promise<void> {
    const lastChecked = status.lastChecked ?? new Date().toISOString().replace('T', ' ').substring(0, 19);
    await this.db
      .prepare(
        `INSERT INTO keepalive_status (user_id, last_checked, last_refreshed, status, message, updated_at)
         VALUES (?,?,?,?,?,datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           last_checked = excluded.last_checked,
           last_refreshed = excluded.last_refreshed,
           status = excluded.status,
           message = excluded.message,
           updated_at = excluded.updated_at`
      )
      .bind(userId, lastChecked, status.lastRefreshed ?? '', status.status, status.message ?? '')
      .run();
  }

  async listKeepaliveStatus(): Promise<KeepaliveStatusRow[]> {
    const { results } = await this.db.prepare('SELECT * FROM keepalive_status').all<KeepaliveStatusRow>();
    return results;
  }

  // --- Request logs ---

  async logRequest(log: RequestLogRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO request_logs
          (api_key, model, endpoint, client, user_agent, stream, status_code, latency_ms, error_message, input_tokens, output_tokens, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`
      )
      .bind(
        log.api_key,
        log.model,
        log.endpoint,
        log.client,
        log.user_agent,
        log.stream,
        log.status_code,
        log.latency_ms,
        log.error_message,
        log.input_tokens,
        log.output_tokens
      )
      .run();
  }

  async cleanupOldLogs(retentionDays: number): Promise<void> {
    // Prune rolled-up daily stats older than retention. Raw request_logs are
    // already bounded to the live window by rollupLogs; the request_logs delete
    // here is a safety net for when the cron is down. Atomic via batch.
    await this.db.batch([
      this.db
        .prepare("DELETE FROM request_logs WHERE datetime(created_at) < datetime('now', ?)")
        .bind(`-${retentionDays} days`),
      this.db.prepare("DELETE FROM stats_daily WHERE day < date('now', ?)").bind(`-${retentionDays} days`),
    ]);
  }

  /**
   * Roll raw request_logs older than `liveWindowDays` into stats_daily and
   * delete the rolled raw rows. Runs on the keepalive cron (every 10 min).
   *
   * Idempotent: each completed day is re-aggregated from raw with REPLACE
   * semantics (ON CONFLICT ... = excluded), so a crash between the aggregate
   * and the delete can't double-count — re-running recomputes the same totals
   * and overwrites; once a day's raw rows are deleted they're never reprocessed.
   * Each day's aggregate + delete runs as one atomic D1 batch.
   */
  async rollupLogs(liveWindowDays: number): Promise<void> {
    const { results } = await this.db
      .prepare("SELECT DISTINCT date(created_at) AS d FROM request_logs WHERE date(created_at) < date('now', ?)")
      .bind(`-${liveWindowDays} days`)
      .all<{ d: string }>();
    for (const row of results ?? []) {
      const d = row.d;
      if (!d) continue;
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO stats_daily (day, api_key, model, request_count, input_tokens, output_tokens, error_count)
             SELECT date(created_at), api_key, model, COUNT(*),
                    COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
                    SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END)
             FROM request_logs WHERE date(created_at) = ?
             GROUP BY api_key, model
             ON CONFLICT(day, api_key, model) DO UPDATE SET
               request_count = excluded.request_count,
               input_tokens = excluded.input_tokens,
               output_tokens = excluded.output_tokens,
               error_count = excluded.error_count`,
          )
          .bind(d),
        this.db.prepare('DELETE FROM request_logs WHERE date(created_at) = ?').bind(d),
      ]);
    }
  }

  // --- Availability monitoring (1-min upstream probe samples) ---

  /** Insert one availability sample + prune rows older than 60 minutes (atomic). */
  async recordAvailabilitySample(ok: number, chatMs: number, pingMs: number, error: string): Promise<void> {
    await this.db.batch([
      this.db
        .prepare('INSERT INTO availability_samples (ok, chat_ms, ping_ms, error) VALUES (?, ?, ?, ?)')
        .bind(ok, chatMs, pingMs, error),
      this.db.prepare("DELETE FROM availability_samples WHERE ts < datetime('now', '-60 minutes')"),
    ]);
  }

  /** Last 60 minutes of availability samples, oldest first. */
  async getAvailabilitySamples(): Promise<AvailabilitySample[]> {
    const { results } = await this.db
      .prepare(
        "SELECT ts, ok, chat_ms, ping_ms, error FROM availability_samples WHERE ts >= datetime('now', '-60 minutes') ORDER BY ts ASC",
      )
      .all<AvailabilitySample>();
    return results ?? [];
  }
}

/** Convenience factory used everywhere a request-scoped store is needed. */
export function createStore(db: D1Database, encKey: string): Store {
  return new Store(db, encKey);
}
