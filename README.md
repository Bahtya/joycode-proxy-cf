# JoyCodeProxy · Cloudflare 边缘版

让 **Claude Code / Cursor / Windsurf** 直接用上 JoyCode 的模型（GLM · Kimi · MiniMax · Doubao），把 Anthropic / OpenAI 协议翻译成 JoyCode 协议——整套跑在 Cloudflare 边缘（Pages + Functions + Cron Worker），无服务器、零常驻进程。

> 本仓库是 [JoyCodeProxy](https://github.com/vibe-coding-labs/JoyCodeProxy)（Go 原版）的 **Cloudflare 边缘端口**：服务端从 Go 用 TypeScript 在 Workers 运行时上重写，前端从 Ant Design 重写为 Tailwind v4 + shadcn/ui（移动优先）。

## 架构

```
Claude Code / Cursor / Windsurf
        │  Anthropic /v1/messages  或  OpenAI /v1/chat/completions
        ▼
┌──────────────────────────────────────────────────────┐
│ Cloudflare Pages                                      │
│   ├─ 静态：React 管理后台（Tailwind v4 + shadcn/ui）   │
│   └─ Pages Functions（TypeScript · Workers 运行时）    │
│        ├─ 协议翻译：Anthropic / OpenAI  ↔  JoyCode    │
│        ├─ 管理后台 API（账号 / 用量 / 设置 / JWT 鉴权）│
│        └─ SSE 流式（ReadableStream）                   │
│           ↓ fetch（ptKey 头）                          │
│        JoyCode 上游（joycode-api.jd.com）             │
│   D1：accounts / settings / request_logs              │
│   KV：扫码登录会话（cookie jar 外置）                 │
└──────────────────────────────────────────────────────┘
        ▲
Cron Worker（*/10 分钟）→ 定时刷新 pt_key，防过期
```

## 功能

- **协议翻译**：Anthropic Messages（含 tool_use 完整映射：tool 定义 / tool_choice / tool_use ↔ tool_calls / 孤立 tool_result 丢弃）+ OpenAI Chat Completions；流式 + 非流式
- **多账号 + api_token 路由**：按 `x-api-key` / `Authorization: Bearer` 选账号
- **扫码登录**：京东 App 扫码加账号（cookie jar 外置 KV，边缘可用）
- **管理后台**：账号管理（拖拽排序）、用量统计、图表、系统设置（移动端响应式）
- **pt_key 自动刷新**：Cron Worker 每 10 分钟刷新，防凭证过期
- **加密存储**：pt_key 用 AES-256-GCM 加密，密钥放 Workers Secret

## 技术栈

TypeScript · React 19 · Vite · Tailwind v4 · shadcn/ui · recharts · @dnd-kit · jose（JWT）· bcryptjs · WebCrypto · Cloudflare D1 / KV / Pages Functions / Cron Triggers

## 部署

见 **[DEPLOY.md](./DEPLOY.md)** —— 从零到上线的完整步骤（D1 / KV 创建、数据库迁移、密钥、前端构建、Pages + Cron 部署、验证）。

## 目录结构

```
functions/            # Pages Functions（/v1 代理 + /api 后台）
src/                  # 共享 TS（协议翻译 / joycode 客户端 / D1 store / 鉴权 / 扫码）
keepalive-worker/     # 配套 Cron Worker（刷新 pt_key）
migrations/           # D1 建表 SQL
web/                  # React 前端（Vite，构建到 ../web-build）
wrangler.toml.example # 部署配置模板（复制为 wrangler.toml 填入自己的 ID）
```

## 免责声明

仅供**个人学习和技术研究**使用。禁止用于商业转售、API 中转服务（**中转站属于违法行为**）、大规模薅号或任何黑灰产 / 违法违规活动。本项目不是 JoyCode / 京东官方产品，与 JoyCode 官方无关。因不当使用造成的一切后果由使用者自行承担。
