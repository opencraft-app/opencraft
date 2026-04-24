---
spec: marketing
change: spec-drift-fix-marketing-routes
delta_type: modified + additive
status: archived
archived_at: 2026-04-23
---

# Delta Spec：Marketing 路由 / 守卫 / 数据流与代码对齐

> 本 delta 为**文档治理型**变更，不涉及任何 runtime 行为调整。目的是让
> `specs/marketing.md` 重新成为代码现状的镜像。

## MODIFIED（路由表整体重写）

### 旧条目（漂移，本次删除）

```
| `/create-openclaw`      | CreateOpenClawPage   | MarketingAuthGuard |
| `/openclaw/setup`       | OpenClawSetupPage    | MarketingAuthGuard |
| `/openclaw/success`     | OpenClawSuccessPage  | MarketingAuthGuard |
| `/openclaw/settings`    | OpenClawSettingsPage | MarketingAuthGuard |
```

### 新条目（代码真实状态）

营销域主路径由 `MarketingAuthGuard` 守卫，且**挂在 `/dashboard/*` 命名空间**下：

| 路由 | 组件 | 职责 |
|------|------|------|
| `/`                    | LandingPage          | 官网首页 |
| `/changelog`           | ChangelogPage        | 更新日志（不需登录） |
| `/dashboard/create`    | CreateOpenClawPage   | 创建 OpenClaw 向导 |
| `/subscribe`           | SubscribePage        | 套餐选择 + 支付下单 |
| `/dashboard/setup`     | OpenClawSetupPage    | OpenClaw 初始化设置 |
| `/dashboard/success`   | OpenClawSuccessPage  | 创建成功落地 |
| `/dashboard/settings`  | OpenClawSettingsPage | 控制台主设置（125KB / 2929 行） |
| `/account`             | AccountPage          | 个人中心（41KB / 1064 行） |
| `/account/orders`      | AccountOrdersPage    | 订单列表（14KB） |
| `/dashboard`（裸）     | `<Navigate>`         | 兜底跳 `/dashboard/settings` |

并保留两套**客户端 Navigate 兼容重定向**，避免老书签 / 外链 404：
- `/create-openclaw`  → `/dashboard/create`
- `/openclaw/setup`   → `/dashboard/setup`
- `/openclaw/success` → `/dashboard/success`
- `/openclaw/settings`→ `/dashboard/settings`
- `/console/{create|setup|success|settings}` → `/dashboard/{...}`

## ADDED（以下章节在旧 spec 中缺失）

### 认证域路由（MarketingLayout + AuthRouteGuard）

| 路由 | 组件 | 说明 |
|------|------|------|
| `/auth/sign-in`        | SignInPage  | 手机号 + 验证码登录 |
| `/auth/sign-up`        | SignUpPage  | 注册（当前已收敛到 sign-in） |
| `/auth/invite`         | InvitePage  | 邀请码校验 |
| `/auth/sign-up-code`   | `<Navigate>`| → `/auth/sign-in` |
| `/auth/forgot-password`| `<Navigate>`| → `/auth/sign-in` |

`AuthRouteGuard` 的职责是"已登录用户访问 `/auth/*` 时跳回首页 `/`"，未登录放行。

### AppShell 域路由（AppAccessGuard + AppShellLayout）

| 路由 | 组件 | 文件 |
|------|------|------|
| `/settings/account`     | AccountProfilePage | `src/pages/app/account-profile-page.tsx` |
| `/bots/:id/workspace`   | WorkspacePage      | `src/pages/app/workspace-page.tsx` |
| `/bots/:id/settings`    | SettingsPage       | `src/pages/app/settings-page.tsx`（调用 `getSettingsSnapshot`） |
| `/bots/:id/terminal`    | BotTerminalPage    | `src/pages/app/bot-terminal-page.tsx` |
| `/*`（AppShell 内兜底） | `<Navigate>`       | → `/dashboard/settings` |

### 已登录用户域（AuthenticatedGuard + PlanGuard）

| 路由 | 组件 | 守卫链 |
|------|------|------|
| `/plans/select` | PlanSelectPage | `MarketingLayout` → `AuthenticatedGuard` → `PlanGuard` |

`PlanGuard` 控制"首次登录必须先选套餐"的时序。

### 内部调试

| 路由 | 组件 |
|------|------|
| `/internal/style-lab` | StyleLabPage |

### 404 兜底

根路由之外的任何路径 → `NotFoundPage`。

## MODIFIED（路由守卫矩阵扩展）

旧 spec 只提 `MarketingAuthGuard`。真实代码（`src/router/guards.tsx`）导出 5 个守卫：

| 守卫 | 职责 | 使用位置 |
|------|------|---------|
| `MarketingAuthGuard`  | 未登录触发登录弹窗，已登录放行 | 营销域主路径 `/dashboard/*` / `/account/*` / `/subscribe` |
| `AuthRouteGuard`      | 已登录访问 `/auth/*` 跳回首页，未登录放行 | `/auth/*` |
| `AuthenticatedGuard`  | 通用登录校验，供子守卫复用 | `/plans/select` 前链 |
| `PlanGuard`           | 首次登录必须先选套餐的时序控制 | `/plans/select` |
| `AppAccessGuard`      | AppShell 域准入；**当前等价 `AuthenticatedGuard`，预留未来订阅 / 权限扩展位** | `/bots/:id/*` / `/settings/account` / `/internal/style-lab` |

## MODIFIED（数据流章节归属更正）

### 旧表述（错误）

> 设置页数据：`getSettingsSnapshot(botId)` → 返回 bot / versions / tools / knowledge / auditEvents / billing

被归在 `openclaw-settings-page.tsx` 名下。

### 新表述（真实）

- **`getSettingsSnapshot(botId)` 的调用方**是 AppShell 分支的
  `src/pages/app/settings-page.tsx`（路由 `/bots/:id/settings`），**不是** marketing 分支的
  `openclaw-settings-page.tsx`。接口定义见 `repositories/types.ts` 第 107 行。

- **`openclaw-settings-page.tsx` 真实依赖的 BotRepository API 清单**（grep 结果）：
  - 创建向导：`createBot` / `listSoulTemplates`（后者实际由 `create-openclaw-page.tsx` 调用）
  - 微信登录（SSE 流）：`createWeixinLoginSession` / `getWeixinLoginSession` /
    `cancelWeixinLoginSession` / `subscribeWeixinLoginSessionEvents`
  - QQ 通道：`configureQQChannel`
  - 终端：`getTerminalSession`
  - 其它：`getBotBornCard` / `renameBot`

## MODIFIED（文件体量数据刷新）

| 文件 | 旧标注 | 新标注（真实） |
|------|--------|---------------|
| `openclaw-settings-page.tsx` | 125KB / 2900+ 行 | **125KB / 2929 行** |
| `subscribe-page.tsx`         | 49KB             | **50KB / 1446 行** |
| `account-page.tsx`           | 41KB             | 41KB / 1064 行（行数补入） |

## MODIFIED（`openspec/config.yaml` 同步）

`config.yaml` 的 `context.路由结构` 小节按本 delta 整体重写：

- 主路径 `/dashboard/*` 化
- 新增 AppShell / 认证域 / 已登录域 / 内部调试 四个子分组
- 新增旧路径兼容重定向说明
- `/account` 大小 34KB → 41KB
- 补 `/dashboard` 裸路径兜底条目

## UNCHANGED（本次未触及）

- 业务规则 #1~#9（登录门禁、布局、动效、文案集中、SEO、响应式断点、Navbar 移动端、
  Feature Flag 源码常量规范、CDN URL 约定）— 已于上次归档 `real-name-verification-and-cdn-cleanup`
  中更新至最新，本次无漂移
- 「核心组件」章节的 landing/ 目录组件清单 — 与代码一致
- 「测试覆盖」章节列出的 `landing-page.test.tsx` / `landing-page.integration.test.tsx`
  / `openclaw-console-helpers.test.ts` / `marketing-header-actions.test.tsx` /
  `login-modal.test.tsx` — 已核实真实存在
- 「已知技术债」章节 — 保留，仍然有效

## NOTE（文档治理后续建议）

1. **CR checklist 增加一条**：任何 `src/router/index.tsx` 改动必须同步 diff
   `specs/marketing.md` 路由表与 `config.yaml` 路由小节
2. **每 2~3 周**做一次类似的 spec drift 审计，避免再次长期失真
3. 如 AppShell 域 `/bots/:id/*` 业务继续扩展，可考虑把 AppShell 章节独立为
   `specs/app-shell.md`，避免 marketing spec 继续膨胀
