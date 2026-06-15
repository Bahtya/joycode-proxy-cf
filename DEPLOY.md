# 部署到 Cloudflare（从零到上线）

边缘端口由三部分组成：**Pages**（静态后台 + Functions 代理/API）、**D1**（数据库）、**KV**（扫码会话），外加一个配套 **Cron Worker**（定时刷新 pt_key）。下面是完整流程。

## 前置

- Node.js 18+
- 一个 Cloudflare 账号
- `npx wrangler`（或全局装 `npm i -g wrangler`）
- 克隆本仓库后：
  ```bash
  npm install                 # 根目录（Workers 侧依赖）
  cd web && npm install       # 前端依赖
  ```

> **Termux / Android 提示**：`workerd`（Workers 本地运行时）没有 android-arm64 二进制，**本地 `wrangler pages dev` 跑不了**——全部对着线上验证。另外 npm script 里的 `tsc` 在 PATH 里找不到，类型检查/构建直接调 `node node_modules/typescript/bin/tsc`。

## 1. 登录 Cloudflare

```bash
npx wrangler login
# 或用 API Token：export CLOUDFLARE_API_TOKEN=cf_xxx（需要 D1/KV/Pages/Workers 编辑权限）
```

## 2. 创建 D1 数据库

```bash
npx wrangler d1 create joycode-proxy-db
```

输出里拿到 `database_id`（一串 UUID），**同时**填进：
- `wrangler.toml` → `database_id`
- `keepalive-worker/wrangler.cron.toml` → `database_id`

两处必须一致（Cron Worker 和 Pages 共享同一个库）。

## 3. 创建 KV 命名空间

```bash
npx wrangler kv namespace create QR_SESSIONS
```

把返回的 `id` 填进 `wrangler.toml` → `[[kv_namespaces]] id`。

## 4. 复制配置模板

仓库里 `wrangler.toml` / `keepalive-worker/wrangler.cron.toml` 被 gitignore（含账号专属 ID，不入库）。从模板复制并填好上面的 ID：

```bash
cp wrangler.toml.example wrangler.toml
cp keepalive-worker/wrangler.cron.toml.example keepalive-worker/wrangler.cron.toml
# 然后编辑两个文件，把 database_id / KV id 填进去
```

## 5. 建表（D1 迁移）

```bash
npx wrangler d1 execute joycode-proxy-db --remote --file=migrations/0001_init.sql
npx wrangler d1 execute joycode-proxy-db --remote --file=migrations/0002_keepalive_status.sql
```

（本地测试用 `--local` 代替 `--remote`。）

## 6. 设置密钥

先生成两个 32 字节 hex 密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Pages 项目密钥：

```bash
npx wrangler pages secret put PTKEY_ENC_KEY --project-name joycode-proxy     # 粘贴上面生成的值
npx wrangler pages secret put JWT_SECRET    --project-name joycode-proxy     # 再生成一个不同的值
```

Cron Worker 也要 **同一个** `PTKEY_ENC_KEY`（解密 pt_key 用）：

```bash
npx wrangler secret put PTKEY_ENC_KEY --config keepalive-worker/wrangler.cron.toml   # 与 Pages 的 PTKEY_ENC_KEY 完全一致
```

> 可选：`AUTH_PASSWORD_HASH`（预先设置好的 bcrypt 哈希），否则首次打开站点用 `/api/auth/setup` 设置管理员密码。

## 7. 创建 Pages 项目

```bash
npx wrangler pages project create joycode-proxy --production-branch main
```

## 8. 构建前端

```bash
cd web
node node_modules/typescript/bin/tsc -b
node node_modules/vite/bin/vite.js build      # 产物输出到 ../web-build
cd ..
```

（非 Termux 环境 `npm run build` 即可。）

## 9. 部署 Pages（静态 + Functions）

```bash
npx wrangler pages deploy --branch main --commit-dirty=true
```

> ⚠️ **关键**：必须用**统一 `wrangler.toml`（`pages_build_output_dir = "./web-build"`）且不带目录参数**部署，D1/KV 绑定才会生效。若用 `wrangler pages deploy ./web-build`（经典模式），`env.DB` 会是 `undefined`。

## 10. 部署 Cron Worker（keepalive）

```bash
npx wrangler deploy --config keepalive-worker/wrangler.cron.toml
```

## 11. 验证

```bash
curl -s https://joycode-proxy.pages.dev/health
# 期望：{"status":"ok","db":"ok","accounts":0,...}
```

然后浏览器打开 `https://<你的项目名>.pages.dev`：
1. 首次访问设置管理员密码。
2. 进「账号管理」→「扫码登录」→ 用京东 App 扫码加账号。
3. 复制账号的 **API Token**，配到 Claude Code：
   ```bash
   export ANTHROPIC_BASE_URL=https://<你的>.pages.dev
   export ANTHROPIC_API_KEY=<API Token>     # 即上面的 api_token（sk-...）
   ```

## 密钥 / 绑定一览

| 名称 | 类型 | 位置 | 说明 |
|------|------|------|------|
| `DB` | D1 | wrangler.toml + cron.toml | 两处 `database_id` 一致 |
| `QR_SESSIONS` | KV | wrangler.toml | 扫码登录 cookie jar |
| `PTKEY_ENC_KEY` | Secret | Pages **和** Cron | AES-256-GCM 密钥（64 hex），两处同值 |
| `JWT_SECRET` | Secret | Pages | HS256 签名密钥 |
| `ASSETS` | 自动 | Pages | 静态资源绑定（SPA fallback 用） |

## 常见问题

- **`env.DB is undefined`**：用了 `wrangler pages deploy ./web-build` 经典模式 → 改用统一配置无目录参数（第 9 步）。
- **OAuth「未检测到自动回调」**：远程部署用不了 OAuth 自动回调（JD 跳 localhost），**用扫码登录**或手动粘贴 pt_key。
- **pt_key 过期**：确认 Cron Worker 已部署（第 10 步），它会每 10 分钟刷新。
- **换账号 / 重建资源**：D1/KV 的 ID 是账号专属，换 Cloudflare 账号要重新 `d1 create` / `kv namespace create` 并替换两个 wrangler 配置里的 ID。
