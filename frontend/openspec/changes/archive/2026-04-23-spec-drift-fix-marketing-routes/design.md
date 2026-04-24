---
change: spec-drift-fix-marketing-routes
status: archived
archived_at: 2026-04-23
---

# 设计文档：Marketing 主 Spec 路由与数据流漂移修复

## 设计目标

1. **Spec 即镜像**：`specs/marketing.md` 必须反映**当前代码现状**，而不是代码重构前的
   历史版本。AI agent、code review、新同事上手都会读这份 spec，失真的 spec 比没有 spec 更危险。
2. **一次做干净**：这次把 marketing 主 spec 里所有已知漂移点一次性修好，避免多次小改；
   同时覆盖 `config.yaml`，保证两处描述一致。
3. **保留历史脉络**：对旧路径（`/openclaw/*`、`/console/*`、`/create-openclaw`）必须
   在 spec 中**明确标注"客户端 Navigate 兼容重定向"**，而不是直接抹掉——便于后人理解为何
   路由表里有这些看似"多余"的条目。
4. **零 runtime 影响**：本次不动任何 `.ts` / `.tsx` 代码，也不改 `.env`、构建脚本。

## 漂移证据（审计快照）

以下证据基于 `2026-04-23` 仓库 HEAD 的真实检索结果，供本变更修复参照。

### 证据 A：路由表已整体重构

`src/router/index.tsx` 中 `MarketingAuthGuard` 子树的主路径为 `/dashboard/*`：

```tsx
{ path: "dashboard/create",   element: <CreateOpenClawPage /> },
{ path: "subscribe",          element: <SubscribePage /> },
{ path: "dashboard/setup",    element: <OpenClawSetupPage /> },
{ path: "dashboard/success",  element: <OpenClawSuccessPage /> },
{ path: "dashboard/settings", element: <OpenClawSettingsPage /> },
{ path: "account",            element: <AccountPage /> },
{ path: "account/orders",     element: <AccountOrdersPage /> },
```

且保留两套客户端 Navigate 兼容：

- `/create-openclaw`、`/openclaw/setup|success|settings` → `/dashboard/*`
- `/console/create|setup|success|settings` → `/dashboard/*`

当前 marketing spec 的路由表仍停留在 `/create-openclaw` / `/openclaw/*` 阶段。

### 证据 B：AppShell 路由分支未写入 spec

`src/router/index.tsx` 还有另一棵子树（`AppAccessGuard` + `AppShellLayout`）完全没有在
marketing spec 出现：

| 路由 | 组件 | 文件 |
|------|------|------|
| `/settings/account` | `AccountProfilePage` | `src/pages/app/account-profile-page.tsx` |
| `/bots/:id/workspace` | `WorkspacePage` | `src/pages/app/workspace-page.tsx` |
| `/bots/:id/settings` | `SettingsPage` | `src/pages/app/settings-page.tsx` |
| `/bots/:id/terminal` | `BotTerminalPage` | `src/pages/app/bot-terminal-page.tsx` |
| `/plans/select` | `PlanSelectPage` | `src/pages/app/plan-select-page.tsx` |
| `/internal/style-lab` | `StyleLabPage` | `src/pages/app/style-lab-page.tsx` |

加上 `AuthRouteGuard` 子树下的 `/auth/sign-in` / `/auth/sign-up` / `/auth/invite`。

### 证据 C：数据流章节归属错误

grep `getSettingsSnapshot`：

- `src/repositories/types.ts:107` — 接口声明
- `src/repositories/http-repositories.ts:684` — http 实现
- `src/repositories/fake-repositories.ts:616` — fake 实现
- `src/pages/app/settings-page.tsx:17` — **唯一的调用方**

`openclaw-settings-page.tsx` **根本没调** `getSettingsSnapshot`，它调用的是
`createWeixinLoginSession` / `subscribeWeixinLoginSessionEvents` /
`configureQQChannel` / `getTerminalSession` / `getBotBornCard` / `renameBot` /
`cancelWeixinLoginSession` 等十余个细颗粒 API。

### 证据 D：守卫矩阵不完整

`src/router/guards.tsx` 导出 5 个守卫：

| 守卫 | 用途 |
|------|------|
| `MarketingAuthGuard` | 营销域 `/dashboard/*`、`/account/*`、`/subscribe` |
| `AuthRouteGuard` | `/auth/*`（已登录用户访问时跳首页） |
| `AuthenticatedGuard` | 通用登录校验（供子守卫复用） |
| `PlanGuard` | `/plans/select` 首次选套餐时序控制 |
| `AppAccessGuard` | AppShell 域 `/bots/:id/*` 等；当前等价 `AuthenticatedGuard`，预留扩展位 |

marketing spec 只提了 `MarketingAuthGuard`。

### 证据 E：文件体量小漂移

`wc -l`：
- `openclaw-settings-page.tsx`：**2929 行** / 125.02 KB（spec 写 "2900+ 行 / 125KB" ✅ 对得上）
- `subscribe-page.tsx`：**1446 行** / **50.57 KB**（spec 写 49KB，轻微偏差）
- `account-page.tsx`：**1064 行** / 41.17 KB（spec 写 41KB ✅ 对；但 config.yaml 写 34KB ❌）

## 修复方案

### 1. 重写 `specs/marketing.md` · 「页面 / 路由」节

**改后结构**：

```
## 页面 / 路由

### 营销域主路径（MarketingAuthGuard）
| 路由 | 组件 | 职责 |
|------|------|------|
| `/`                    | LandingPage          | 官网首页 |
| `/changelog`           | ChangelogPage        | 更新日志 |
| `/dashboard/create`    | CreateOpenClawPage   | 创建 OpenClaw 向导 |
| `/subscribe`           | SubscribePage        | 套餐选择 + 支付下单 |
| `/dashboard/setup`     | OpenClawSetupPage    | OpenClaw 初始化设置 |
| `/dashboard/success`   | OpenClawSuccessPage  | 创建成功落地 |
| `/dashboard/settings`  | OpenClawSettingsPage | 控制台主设置（125KB / 2929 行） |
| `/account`             | AccountPage          | 个人中心（41KB / 1064 行） |
| `/account/orders`      | AccountOrdersPage    | 订单列表 |
| `/dashboard`（裸路径） | Navigate             | 兜底跳 `/dashboard/settings` |

### 旧路径兼容重定向（仅客户端 Navigate）
- `/create-openclaw`  → `/dashboard/create`
- `/openclaw/setup`   → `/dashboard/setup`
- `/openclaw/success` → `/dashboard/success`
- `/openclaw/settings`→ `/dashboard/settings`
- `/console/{create|setup|success|settings}` → `/dashboard/{...}`

### 认证域（MarketingLayout + AuthRouteGuard）
- `/auth/sign-in` / `/auth/sign-up` / `/auth/invite`
- `/auth/sign-up-code` / `/auth/forgot-password` → Navigate `/auth/sign-in`

### AppShell 域（AppAccessGuard + AppShellLayout）
- `/settings/account`     → AccountProfilePage
- `/bots/:id/workspace`   → WorkspacePage
- `/bots/:id/settings`    → SettingsPage ← 此处调用 getSettingsSnapshot
- `/bots/:id/terminal`    → BotTerminalPage
- `/*`（AppShell 内兜底）→ Navigate `/dashboard/settings`

### 已登录用户可访问（AuthenticatedGuard + PlanGuard）
- `/plans/select` → PlanSelectPage（首次登录选套餐）

### 内部调试
- `/internal/style-lab` → StyleLabPage
```

### 2. 扩展「路由守卫」描述

新增一段小表列出 5 个守卫职责。明确 `AppAccessGuard` 为"当前等价 `AuthenticatedGuard` 的
占位守卫，预留订阅校验等业务扩展位"。

### 3. 重写「数据流」节

- 把 `getSettingsSnapshot(botId)` 从 `openclaw-settings-page` 移到 AppShell 的
  `settings-page.tsx` 名下
- 补列 `openclaw-settings-page.tsx` 真实依赖的 `BotRepository` API 清单：
  - 创建向导：`createBot` / `listSoulTemplates`
  - 微信登录：`createWeixinLoginSession` / `getWeixinLoginSession` /
    `cancelWeixinLoginSession` / `subscribeWeixinLoginSessionEvents`
  - QQ 配置：`configureQQChannel`
  - 终端：`getTerminalSession`
  - 其它：`getBotBornCard` / `renameBot`

### 4. 刷新文件体量数据

- `subscribe-page.tsx`：49KB → 50KB（1446 行）
- `openclaw-settings-page.tsx` 保持 "125KB / 2929 行"（数字对齐）

### 5. 同步 `config.yaml`

- `context.路由结构` 小节按 `/dashboard/*` 体系重写，并新增 AppShell / Auth / 已登录
  / 内部调试四个子表
- `/account` 大小：34KB → 41KB
- 新增 `/dashboard` 兜底重定向条目
- 新增旧路径兼容说明

## 关键决策

| 决策 | 选项 | 选择 | 理由 |
|------|------|------|------|
| 是否代码回迁旧路径 | A. 删除兼容重定向 B. 保留 | **B** | 老书签/外链仍在流通，观察窗口期未到 |
| spec 是否保留"旧路径" | A. 抹掉 B. 单列小节 | **B** | 解释代码中 Navigate 重定向条目的存在动机 |
| 是否拆分 marketing spec | A. 拆成 marketing / app-shell 两份 | B. 维持单一 marketing spec | **B** | 目前两棵路由树都归在"前端"一个心智模型下，单 spec 更好索引；未来如果 AppShell 业务变重再拆 |
| `AppAccessGuard` 如何描述 | A. 写"等价 Authenticated" B. 省略 | **A** | 让 reader 理解代码里看起来"多余"的守卫只是预留扩展位 |
| 文件大小数据写到 KB 还是行数 | A. KB B. 行数 C. 都写 | **C** | KB 便于快速感知体量，行数更稳定（方便日后验证是否又变大了） |

## 风险

- **极低**：纯文档变更，无 runtime 影响，回滚 = `git revert` 一次
- **唯一风险**：未来代码再次重构路由后，spec 依然会漂移。缓解措施：
  - 每次路由重构时必须同步改 `specs/marketing.md` 和 `config.yaml`（纳入 CR checklist）
  - 每 2~3 周做一次类似的 spec drift 审计（可作为日常 runbook 一部分）

## 已知权衡

- **单 spec 继续膨胀**：合并 AppShell 章节后，marketing.md 会从 131 行增长到约 180 行。
  未来如果 `/bots/:id/*` 路由业务继续扩展，可能需要独立出 `specs/app-shell.md`。
- **兼容重定向的小节**：看起来啰嗦，但保留能回答"为什么路由表里还有 `/openclaw/*`"
  这个新人必问的问题，值得占篇幅。
