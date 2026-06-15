// POST /api/accounts-import — import an accounts JSON array (re-encrypting pt_keys).
// Ports pkg/dashboard/handler.go handleImportAccounts + store.ImportAccounts.
// Body: { accounts: ExportAccountItem[] }
// Response shape (web/src/api.ts importAccounts):
//   { ok: true, added: number, updated: number, total: number }
//
// Behavior mirrors Go store.ImportAccounts:
//   * Skip entries missing user_id or pt_key.
//   * If an account with the same user_id already exists, it's an update
//     (store.addAccount upserts / re-encrypts the pt_key); count as "updated".
//   * Otherwise it's a new insert; enforce the MAX_ACCOUNTS limit.
import type { Env } from '../../src/types';
import { createStore } from '../../src/store/d1';

interface ImportItem {
  user_id?: string;
  nickname?: string;
  remark?: string;
  pt_key?: string;
  is_default?: boolean;
  default_model?: string;
  display_order?: number;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: { accounts?: ImportItem[] };
  try {
    body = (await request.json()) as { accounts?: ImportItem[] };
  } catch {
    return Response.json({ detail: 'invalid JSON body' }, { status: 400 });
  }

  const items = Array.isArray(body.accounts) ? body.accounts : [];
  if (items.length === 0) {
    return Response.json({ detail: 'accounts array is empty' }, { status: 400 });
  }

  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  const maxAccounts = Number(env.MAX_ACCOUNTS) || 10;

  let added = 0;
  let updated = 0;

  for (const item of items) {
    const userId = item.user_id?.trim() ?? '';
    const ptKey = item.pt_key?.trim() ?? '';
    if (!userId || !ptKey) continue; // mirrors Go: skip empty user_id/pt_key

    const existing = await store.getAccount(userId);
    const existed = existing !== null;

    // Enforce the account limit only for genuinely new accounts (updates bypass it),
    // matching Go store.AddAccount which enforces MaxAccounts only on the insert path.
    if (!existed) {
      const count = await store.countAccounts();
      if (count >= maxAccounts) {
        return Response.json(
          {
            detail: `账号数量已达上限（${maxAccounts} 个）。本工具仅供个人学习和研究使用，禁止用于商业转售、API 中转服务或任何违法违规用途`,
          },
          { status: 400 }
        );
      }
    }

    await store.addAccount({
      userId,
      nickname: item.nickname ?? '',
      remark: item.remark ?? '',
      ptKey,
      isDefault: !!item.is_default,
      defaultModel: item.default_model ?? '',
    });

    if (existed) updated++;
    else added++;
  }

  return Response.json({ ok: true, added, updated, total: added + updated });
};
