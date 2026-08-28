# Bot 工作台模块 (Bot / Workspace)

## 概述

Bot 工作台模块覆盖**已创建 OpenClaw 实例的完整生命周期控制台操作**：Dashboard、
Workspace（对话工作台）、Settings（配置）、Terminal（调试终端）。是付费用户
的日常使用主阵地，位于 `AppShellLayout` 下。

## 页面 / 路由

| 路由 | 组件 | 守卫 | 职责 |
|------|------|------|------|
| `/bots/:id/workspace` | `WorkspacePage` | AppAccessGuard + AppShellLayout | 对话工作台主界面 |
| `/bots/:id/settings` | `SettingsPage` | 同上 | Bot 配置（轻量版，6.4KB） |
| `/bots/:id/terminal` | `BotTerminalPage` | 同上 | 调试终端（xterm，13.8KB） |
| `/settings/account` | `AccountProfilePage` | 同上 | 账号资料（控制台内） |
| `/internal/style-lab` | `StyleLabPage` | AppAccessGuard | 设计系统预览（内部） |

> 兜底：控制台内部 `*` 重定向到 `/openclaw/settings`（marketing 域控制台主页）。

## 核心组件

- `pages/app/workspace-page.tsx` — 工作台（对话 + 快捷操作）
- `pages/app/settings-page.tsx` — Bot 设置（6.4KB，轻量版）
- `pages/app/bot-terminal-page.tsx` — 终端（13.8KB，基于 `@xterm/xterm` + `@xterm/addon-fit`）
- `components/domain/bot-status-card.tsx` — Bot 运行状态卡
- `components/domain/setup-step-timeline.tsx` — 初始化步骤时间线
- `components/domain/event-feed.tsx` — 事件流
- `components/domain/alert-card.tsx` — 告警
- `components/domain/audit-log-table.tsx` — 审计日志
- `components/domain/release-item.tsx` — 发布版本项
- `components/domain/scenario-switcher.tsx` — 场景切换
- `components/ui/chat-bubble.tsx` — 聊天气泡
- `components/ui/composer-panel.tsx` — 工作台消息输入面板
- `layouts/app-shell-layout.tsx` — 控制台 Shell 布局（侧边栏 + 顶栏）

## 数据流

### 快照模型

为减少请求次数，后端按页面提供聚合快照：

| Snapshot | 接口 | 字段 |
|----------|------|------|
| `DashboardSnapshot` | `getDashboardSnapshot(mode?)` | runtime / alerts / bots / deployments / releases / billing |
| `WorkspaceSnapshot` | `getWorkspaceSnapshot(botId, mode?)` | bot / runtime / messages / quickActions |
| `SettingsSnapshot` | `getSettingsSnapshot(botId, mode?)` | bot / versions / tools / knowledge / auditEvents / billing |

`mode` 参数控制 `"live"` / `"demo"` 数据源，便于运营/演示。

### API 层 (`BotRepository`)

**快照 & CRUD**
- `getDashboardSnapshot / getWorkspaceSnapshot / getSettingsSnapshot`
- `createBot({name?, soulTemplateId?})` — 创建 Bot
- `destroyBot(botId)` — 销毁
- `updateBotProfile(botId, patch)` — 修改 `name / type / template / mission / scenario / status`

**工作台交互**
- `sendWorkspaceMessage(botId, text)` → 返回新增 `WorkspaceMessage[]`
- `listSoulTemplates()` — 灵魂模板列表（创建向导用）

**终端与调试**
- `getTerminalSession(botId)` → `BotTerminalSession`（WS / SSE 地址）
- `execDebugCommand(botId, command)` → `{status, exitCode, output}`

**通道绑定**
- `configureQQChannel(botId, {appId, appSecret, account?})`
- 微信登录全流程（SSE 事件流）：
  - `createWeixinLoginSession(botId)` → `{sessionId, status}`
  - `getWeixinLoginSession(botId, sessionId)` → `WeixinLoginSession`
  - `cancelWeixinLoginSession(botId, sessionId)`
  - `subscribeWeixinLoginSessionEvents(botId, sessionId, signal?)` — AsyncIterable，
    订阅 `{event, data}` 事件流

### 状态管理

- 各控制台页使用 `useAsyncResource(fetcher, deps)` 直接包装对应快照接口，
  不走全局 Context，保持页面级独立性。
- 全局只通过 `SessionProvider` 共享用户 / 订阅态，`OpenClawProvider` 共享当前
  OpenClaw 实例。

## 业务规则

1. **准入门禁**：`AppAccessGuard` 校验「登录 + 有有效套餐 + 至少一个 Bot」，
   任一缺失都重定向到对应补全页（登录页 / 选套餐 / 创建 OpenClaw）。
2. **路径风格**：控制台页以 `/bots/:id/*` 为前缀；Marketing 域控制台以
   `/openclaw/settings` 为主页（路径不一致是历史原因，两套控制台并存）。
3. **终端安全**：`BotTerminalPage` 只允许执行白名单调试命令，`execDebugCommand`
   后端会做二次校验。
4. **微信登录 SSE**：订阅使用 AsyncIterable + AbortSignal，组件卸载时必须
   `controller.abort()` 释放连接。
5. **数据模式切换**：`mode=demo` 用于演示/文档截图，不写库；默认 `live`。
6. **样式统一**：控制台页样式必须走 `components/ui/*` 设计系统，禁止在业务页
   手写散样式（参考 frontend/README.md "设计系统重构" 章节）。

## 测试覆盖

目前控制台页测试较少，建议后续补齐：
- `plan-select-page.test.tsx`（选套餐，跨模块）
- `session-context.test.tsx`（会话 reducer）

## 相关后端服务

- `ctl/` — OpenClaw 生命周期控制
- `ai-gateway/` — AI 对话网关（Workspace 聊天）
- `sandbox/` — 沙箱执行（Terminal）
- `session/` — 会话状态

## 已知待办

- 控制台部分页面复用度低，后续可抽出 `components/domain/` 下更多原语。
- 终端 / Workspace 的长连接重试策略尚未统一封装。
