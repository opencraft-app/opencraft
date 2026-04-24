# Gateway Dashboard Agent Guide

本文档适用于开发 `gateway-dashboard/` 子项目时参考。开发前请先阅读本文档。

## 项目概述

Gateway Dashboard 是 AI Gateway 的管理后台，用于用户管理、套餐管理、Provider 管理、API Key 管理等。

**技术栈**: Next.js 16 + React 19 + TypeScript + Tailwind CSS 4 + shadcn/ui

> **Note**: Dashboard 启动时会通过 BFF 代理连接 AI Gateway 后端，后端再连接 Portkey Gateway。

## 构建与运行

### 一键启动（推荐）

在项目根目录运行：

```bash
# 后台启动所有服务（包括 Dashboard 前端）
make dev

# 只启动 Dashboard 前端 (端口 13000)
make dashboard
```

### 进入 gateway-dashboard 目录操作

```bash
cd gateway-dashboard
npm run dev               # Next.js dev server
npm run build             # production build
npm run lint              # eslint
```

Portkey Gateway 运行时归属 `ai-gateway/`，如需本地启动 Portkey，请在 `ai-gateway/` 目录使用 `make portkey` 或 `make dev`。

Dashboard requires `.env` with `GATEWAY_API_URL` and `ADMIN_TOKEN` (see `.env.example`).

## 架构

### Next.js App Router

```
src/
  app/
    api/ai-gateway/[...path]/route.ts → BFF proxy to ai-gateway /api/admin/*
    api/auth/[...path]/route.ts       → BFF proxy to user-auth /admin/*
    api/subscription/[...path]/route.ts → BFF proxy to subscription /admin/*
    api/sandbox/[...path]/route.ts    → BFF proxy to sandbox-api /internal/*
    api/ctl/[...path]/route.ts        → BFF proxy to ctl-api /internal/*
    dashboard/page.tsx     → stats overview
    layout.tsx             → root layout (dark mode, QueryProvider, Shell)
  components/
    ui/                    → shadcn/ui components (base-nova style)
    layout/                → Shell, Sidebar, Header, ErrorBoundary
    shared/                → DataTable, ConfirmDialog, PageHeader
    dashboard/             → stats cards, charts (recharts)
  lib/
    api-client.ts          → typed fetch wrapper with ApiError class
    queries/               → TanStack React Query hooks (use-users, use-plans, etc.)
    utils.ts               → cn() utility
```

### 数据流

React Query hooks → `apiClient()` → public `/admin/api/<module>/*` → `admin-gateway` rewrite → Next.js BFF route under `/admin/gateway/api/<module>/*` → backend admin API. BFF forwards the current Dashboard admin token, or a module-specific server-side token when that token is configured.

公网模块前缀：

- `/admin/api/ai-gateway/[...path]` → `ai-gateway /api/admin/*`
- `/admin/api/auth/[...path]` → `user-auth /admin/*`
- 运行时需要额外配置 `AUTH_ADMIN_API_URL`
- `/admin/api/subscription/[...path]` → `subscription /admin/*`
- 运行时需要额外配置 `SUBSCRIPTION_ADMIN_API_URL`
- `/admin/api/sandbox/[...path]` → `sandbox-api /internal/*`
- `/admin/api/ctl/[...path]` → `ctl-api /internal/*`

## UI 组件系统

shadcn/ui with `base-nova` style, Tailwind CSS 4, Lucide icons. Components use `@/components/ui` path alias. Add new components via `npx shadcn@latest add <component>`.

## 环境变量

| Variable | Required | Purpose |
|---|---|---|
| `GATEWAY_API_URL` | Yes | Backend URL for BFF proxy |
| `AUTH_ADMIN_API_URL` | No | `user-auth` 管理 API URL（认证用户/验证码/邀请码页面使用） |
| `SUBSCRIPTION_ADMIN_API_URL` | No | `subscription` 管理 API URL（业务订阅页面使用） |
| `ADMIN_TOKEN` | Yes | Admin API authentication |
