---
id: cn-sidebar-session-pagination-task
type: task
scope: 国内站 Agent 左导航最近会话列表分页。
triggers: ["最近会话查看更多", "Agent 左导航对话列表"]
owner: LightVela 产品团队
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-05-cn-sidebar-session-pagination.md
status: active
reviewed_at: 2026-10-05
review_due: 2026-10-19
revision: 1.0.0
precedence: task
derived: false
---

## goal

国内站 Agent 左导航最近会话默认展示 5 条，并通过「查看更多」每次增加 5 条。

## non_goals

- 不更改国际站当前 20 条分页、会话排序、服务端分页接口或生产部署。

## requirement_ids / requirement_refs / requirement_excerpt

- 2026-10-05 用户在国内站 5174 本地预览中提出；外部需求标识 unknown。超过 5 条时显示「查看更多」，每次展开 5 条。

## interface_refs / data_structure_refs

- `useAgentSessionPagination` 接收已加载会话、服务端是否仍有更多及加载动作；保持按更新时间排序、服务端按需加载与重置行为。

## history_context

- `current_design_refs`：`frontend/src/pages/marketing/agent-settings-page.tsx` 与 `agent-session-pagination.ts` 当前实现。
- `relevant_evolution`：当前本地预览来自 `cn-chat-welcome-mascot` 工作树，列表原先每批 20 条。
- `superseded_refs`：无。

## acceptance

- 国内站恰好 5 条时无「查看更多」；6 条及以上时出现；点击后显示数按 5、10、15 递增，末批可不足 5 条。
- 服务端还有更多时继续支持加载；国际站维持 20 条。5174 预览运行于目标工作树。

## affected_paths

- `frontend/src/pages/marketing/agent-session-pagination.ts`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-session-pagination.test.tsx`

## required_context

- 路由 Pack：`service-frontend`、`site-environment-routing`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
| --- | --- | --- |
| `AGENTS.md@working-tree` | 仓库边界 | Task Pack 与验证要求 |
| `docs/context/project/services/frontend.md@working-tree` | 路由器 must-read | 前端验证范围 |
| `docs/context/domains/site-environment-routing.md@working-tree` | 路由器 must-read | 国内／国际隔离 |
| `frontend/AGENTS.md@working-tree` | 服务规则 | 检查与构建门禁 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@working-tree` | 前端邻接卡 | 检查测试邻居 |
| `frontend/src/pages/marketing/agent-session-pagination.ts@working-tree` | 当前实现 | 每批数量与按钮条件 |
| `frontend/src/pages/marketing/agent-settings-page.tsx@working-tree` | 当前调用与 UI | 国内站传入 5 条 |
| `frontend/src/pages/marketing/__tests__/agent-session-pagination.test.tsx@working-tree` | 相邻测试 | 边界与加载回归 |

## evidence

- 聚焦 Vitest 41/41 通过（分页及侧栏测试）；`pnpm check` 通过，TypeScript 0 新诊断；`pnpm build:cn`、`pnpm build:global` 通过。
- 后续将国内站对话列表加载提示改为「正在加载...」；侧栏测试 37/37、`pnpm check`、`pnpm build:cn` 再次通过，Chrome 本地预览已显示新文案。
- 文档校验 0 断链、0 未分类；变更影响检查通过；`git diff --check` 通过。
- 5174 监听进程 PID 69240 的 cwd 为本工作树 `frontend/`；`/agents/overview/` 返回 200。已登录 Chrome 预览中侧栏与页面显示正常，但当前对话区停留在「正在加载会话…」；应用内浏览器是未登录状态。

## risks

- 若当前账号会话不足 6 条，浏览器无法观察按钮；用 5/6 边界及展开测试覆盖。

## validation

- 聚焦 Vitest、`pnpm check`、`pnpm build:cn`、`pnpm build:global`、文档校验、`git diff --check` 与 5174 预览检查。

## decisions

- 国内站传入分页大小 5；hook 维持默认 20 供国际站使用。依据用户当前国内站预览范围。

## scan_scope

- `frontend/src/pages/marketing/agent-session-pagination.ts`、`agent-settings-page.tsx` 及聚焦测试。

## scan_output

- 有界搜索命中 hook 调用及「查看更多」按钮渲染，未扩展到其他服务。

## handoff

- 国内站本地预览已更新到 5174；由于账号会话未加载，尚无真实列表点验。用户已授权提交 MR，尚未合并或发布生产。

## checkpoint

### stage

实现及前端门禁完成；本地预览运行中。

### verified

- 目标工作树是当前 5174 国内站预览的工作树；分页由单一 hook 控制。
- 聚焦测试 41/41、类型检查、双站构建与文档校验通过；5174 页面返回 200。

### unverified

- 真实账号中超过 5 条会话的按钮交互；当前 Chrome 对话区持续加载，应用内浏览器未登录。

### discard

- 无。

### restore

- 工作树：`/Users/pablozhong/.codex/worktrees/cn-chat-welcome-mascot/lightvela`。

### next_action

将已验证的左导航改动提交 MR；真实列表点验仍需有会话的登录态。
