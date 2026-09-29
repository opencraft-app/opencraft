---
id: task-hide-sidebar-new-session-2026-09-24
type: task
scope: 隐藏 Agent 对话页侧栏中无效的新会话入口。
triggers: ["Agent sidebar new session", "左侧新会话置灰", "隐藏新会话按钮"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - frontend/src/pages/marketing/agent-settings-page.tsx
  - frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md
status: active
reviewed_at: 2026-09-24
review_due: 2026-12-23
revision: 1.0.0
precedence: task
derived: false
---

## goal
隐藏 Agent 对话页侧栏中始终置灰的“新会话”按钮。

## non_goals
- 不修改聊天面板右上角的新建会话入口或会话协议。
- 不合并 MR、发布或变更线上服务。

## requirement_ids / requirement_refs / requirement_excerpt
- 本轮用户请求：“左边导航的‘新会话’按钮，先隐藏掉吧”。
- 后续用户要求：“提交mr”。

## interface_refs / data_structure_refs
- `AgentChatMigrationSurface` 的会话状态桥接；`AgentChatPanel` 自带的新建会话按钮。

## history_context
- `current_design_refs`: `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md` 指定新建入口在面板内，侧栏只展示会话列表。
- `relevant_evolution`: `origin/master@1bbb1a12a` 的侧栏后来增加了依赖新版工作台命令的按钮；普通聊天面板未提供该命令。
- `superseded_refs`: 无。

## acceptance
- 左侧“对话”导航不渲染“新会话”按钮，最近会话列表仍显示。
- 聊天面板自身的新建会话入口保持可用。
- 聚焦测试及现有前端 `check` 门禁通过。
- 创建以 `master` 为目标分支的 Gongfeng MR，并核对远端分支 SHA。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `frontend/src/pages/marketing/__tests__/agent-settings-sdk-boundary.test.ts`

## required_context
- `frontend-product-surface`、`service-frontend`、`site-environment-routing`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@1bbb1a12a` | 前端服务门禁 | 确定验证范围 |
| `docs/context/domains/site-environment-routing.md@1bbb1a12a` | 双站边界 | 确认共用代码覆盖 |
| `frontend/AGENTS.md@1bbb1a12a` | 前端规则 | 确定 lint/type/test 门禁 |
| `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md@1bbb1a12a` | 侧栏设计 | 保留面板创建入口 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1bbb1a12a` | 邻接规则 | 核对相邻测试 |

## evidence
- 2026-09-24 在 Firefox 线上页面确认左侧按钮禁用、面板右上角按钮可用；发布源码 `fc1cd61192d7` 的侧栏禁用条件为 `chatSessionCommands === null || chatSessionMutationState?.pending === true`。
- 在独立工作树 `origin/master@1bbb1a12a` 移除侧栏按钮及其宿主命令状态；右上角 AgentChat 面板与 OpenCraft 工作台内的创建逻辑未改动。
- 聚焦 Vitest 41/41 通过；`pnpm check` 通过，TypeScript 诊断 171 current / 171 baseline / 0 new；`build:cn` 与 `build:global` 均通过。
- `validate_documentation.py` 通过；Context 全量校验被仓库已有 Task Pack 元数据与历史上下文格式问题阻断。

## risks
- 侧栏少一个入口；面板右上角入口仍提供相同操作。恢复可回退本次源码变更。

## validation
- 聚焦 Vitest 41/41、`pnpm check`、国内/国际构建、`git diff --check` 均通过。
- 仓库无 `pnpm lint` 脚本；Vitest 需临时使用 127.0.0.1，因为本机无法解析 localhost，临时配置已删除。

## decisions
- 按用户最新要求隐藏侧栏按钮，不接入旧面板命令。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx` 及相邻测试。

## scan_output
- `rg` 命中侧栏按钮及唯一宿主命令消费点。

## handoff
- 提交 MR 后以工蜂实时状态为准；本任务不包含合并或发布。

## checkpoint
- `stage`: 本地实现与服务门禁完成；下一步创建并核验 MR。
- `verified`: 左侧入口源码已移除；聚焦测试与双站构建通过。
- `unverified`: 未在登录态本地预览实页；线上页面仍为旧发布版本。
- `discard`: 不使用旧分支源码判断线上状态；全量 Context 校验的既有 Task Pack 报错与本改动无关。
- `restore`: 独立工作树路径为 `/Users/pablozhong/.codex/worktrees/hide-disabled-new-session/lightvela`。
- `next_action`: 提交并核验 MR；合并与发布另行处理。
