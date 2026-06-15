// POST /api/clear-joycode-session — clear the local JoyCode IDE session.
// Ports pkg/dashboard/handler.go handleClearJoyCodeSession.
//
// DEVIATION (intentional): the Go handler opens the local JoyCode IDE's
// `state.vscdb` SQLite file (`~/Library/Application Support/JoyCode/.../state.vscdb`)
// and DELETEs the JoyCoder.IDE / joycode.storageUser rows. In a serverless edge
// deployment there is no host filesystem and no JoyCode IDE install to touch,
// so the operation is a no-op. We still return the success shape the frontend
// expects (web/src/api.ts clearJoyCodeSession): { ok: true, message: string }.
//
// If a session marker is ever stored in QR_SESSIONS KV (e.g. for OAuth flow
// state), we proactively clear any 'joycode_session_*' keys we can find.
import type { Env } from '../../src/types';

export const onRequestPost: PagesFunction<Env> = async ({ env }) => {
  let cleared = 0;
  try {
    // KV.list is eventually consistent and paginated; best-effort cleanup only.
    let cursor: string | undefined;
    do {
      const list = await env.QR_SESSIONS.list<{ cursor?: string }>({ prefix: 'joycode_session_', cursor });
      for (const k of list.keys) {
        await env.QR_SESSIONS.delete(k.name);
        cleared++;
      }
      cursor = list.list_complete ? undefined : (list.cursor as string | undefined);
    } while (cursor);
  } catch {
    // KV cleanup is best-effort; ignore.
  }

  return Response.json({
    ok: true,
    message:
      '边缘部署无法访问本地 JoyCode IDE 数据库，已清除服务端会话标记。' +
      (cleared > 0 ? `（已清除 ${cleared} 条服务端会话）` : '请在本地 JoyCode IDE 中手动退出登录后重试。'),
  });
};
