---
id: cn-mobile-chat-layout
type: task
scope: 国内站新版嵌入式 Chat 的移动浏览器布局修复。
triggers: ["国内站", "对话", "移动端"]
owner: LightVela frontend
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-02-cn-mobile-chat-layout.md
status: active
reviewed_at: 2026-10-02
review_due: 2026-10-16
revision: 1.0.0
precedence: task
---

## goal

让国内站 `/agents/chat/` 在手机宽度下直接显示可操作的聊天区与输入框，并保留 Bot 与会话导航入口。

## non_goals

- 不改国际站、会话协议、消息发送或 OpenCraft 内部行为。
- 不合并、发布或改动生产环境。

## requirement_ids / requirement_refs / requirement_excerpt

- 本轮用户反馈（2026-10-02）：新版国内站对话功能在移动端浏览器显示有问题；外部需求标识 `unknown`。

## interface_refs / data_structure_refs

- `AgentSettingsPage` 宿主布局、`AgentSidebar` 与 `AgentChatMigrationSurface`；不改变 `selectedChatId` 或 Bot 状态来源。

## history_context

- `current_design_refs`: `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md`。
- `relevant_evolution`: 国内站现已默认显示 OpenCraft 嵌入式 Chat；桌面聊天页已有视口高度布局，移动端仍按普通设置页纵向堆叠。
- `superseded_refs`: 无。

## acceptance

- 320px 与 390px 视口首屏可见聊天输入框；Bot 和会话导航可展开、关闭与选择。
- 桌面聊天布局和国际站保持原状。
- 前端聚焦测试、`pnpm check`、必要构建与 `git diff --check` 通过。

## affected_paths

- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/opencraft-embedded-workbench.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `frontend/src/styles.css`
- 本 Task Pack 与检查点。

## required_context

- `site-environment-routing`；`docs/context/domains/site-environment-routing.md`；`frontend/AGENTS.md`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
| --- | --- | --- |
| `docs/context/domains/site-environment-routing.md@b42d361c7` | 国内与国际站边界 | 限定国内站 |
| `frontend/AGENTS.md@b42d361c7` | 服务规则 | 前端验证门禁 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@working-tree` | 前端邻接 | 对照 OpenSpec 与测试 |
| `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md@b42d361c7` | 侧栏历史设计 | 保留会话导航 |
| `frontend/src/pages/marketing/agent-settings-page.tsx@b42d361c7` | 当前宿主实现 | 定位移动布局 |
| `frontend/src/pages/marketing/opencraft-embedded-workbench.tsx@b42d361c7` | 相邻嵌入容器 | 核对固定高度来源 |

## evidence

- 2026-10-02 生产页 `/agents/chat/` 的 390px 视口：侧栏从 y=96 到 y=451，Chat 从 y=475 开始，输入框须滚动后可见；320px 同类现象。
- `origin/master@b42d361c7` 的样式与工蜂 API 最新 `master@a2f68ea8` 完全一致；宿主文件仅有一处与本布局无关的暂停状态参数差异。
- 本地 320×700：导航条 y=60–104，聊天容器 y=104–700，文档宽高 320×700；390×844：导航条 y=60–104，聊天容器 y=104–844，文档宽高 390×844。展开、选中默认会话、Esc 关闭均经过浏览器点击验证。
- 生产 OpenCraft 输入区底边距离其宿主底边约 57.5px；将该相对位置用于本地新宿主高度，推断连接成功时输入区会在首屏内。此项不是本地真实输入实测。

## risks

- 真实手机键盘与浏览器动态工具栏可能改变可视高度；以 `dvh` 收缩聊天容器，并用手机宽度浏览器验证。
- 本地 Bot 暂停且 OpenCraft 连接失败，无法在本地账号验证真实输入与发送；布局容器与导航已验证。

## validation

- 国内站 320px、390px 的 Chat 首屏、导航展开与关闭；桌面与国际站回归。
- 聚焦测试、`pnpm check`、适用构建、`git diff --check`。
- 50 项聚焦测试、`pnpm check`、`pnpm build:cn`、`git diff --check` 均通过。

## decisions

- 移动 Chat 用可展开的 Bot/会话导航替代占满首屏的常驻侧栏，聊天区占用剩余视口；本轮实现选择。

## scan_scope

- `frontend/src/pages/marketing/agent-settings-page.tsx`、`opencraft-embedded-workbench.tsx`、`frontend/src/styles.css` 及相邻测试。

## scan_output

- 有界搜索命中 `lv-agent-settings-grid`、`lv-agent-chat-page`、`AgentChatMigrationSurface`、移动端侧栏媒体查询。

## handoff

- 修复与可用的本地验证完成；真实聊天输入需可运行 Bot 复测。本轮用户已授权提交 MR，仍不合并或发布。
