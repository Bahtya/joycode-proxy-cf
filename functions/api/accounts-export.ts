// GET /api/accounts-export — export all accounts (DECRYPTED pt_keys) as JSON for backup.
// Ports pkg/dashboard/handler.go handleExportAccounts + store.ExportAccounts.
// SECURITY: this returns plaintext credentials and MUST only be reachable behind
// the JWT admin middleware (functions/api/_middleware.ts).
// Response shape (web/src/api.ts exportAccounts):
//   { ok: true, accounts: ExportAccountItem[], count: number }
import type { Env, AccountRow } from '../../src/types';

export interface ExportAccountItem {
  user_id: string;
  nickname: string;
  remark: string;
  pt_key: string; // decrypted
  is_default: boolean;
  default_model: string;
  display_order: number;
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const { results } = await env.DB
    .prepare(
      'SELECT user_id, nickname, remark, pt_key, is_default, default_model, COALESCE(display_order, 0) AS display_order FROM accounts ORDER BY display_order, created_at'
    )
    .all<AccountRow & { display_order: number }>();

  const items: ExportAccountItem[] = [];
  for (const row of results ?? []) {
    let ptKey = '';
    try {
      const { decrypt } = await import('../../src/store/crypto');
      ptKey = await decrypt(row.pt_key, env.PTKEY_ENC_KEY);
    } catch {
      // Skip accounts whose pt_key cannot be decrypted (mirrors Go's ExportAccounts).
      continue;
    }
    items.push({
      user_id: row.user_id,
      nickname: row.nickname ?? '',
      remark: row.remark ?? '',
      pt_key: ptKey,
      is_default: row.is_default === 1,
      default_model: row.default_model ?? '',
      display_order: row.display_order ?? 0,
    });
  }

  return Response.json({ ok: true, accounts: items, count: items.length });
};
