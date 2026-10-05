---
id: cn-bot-status-avatar-dot-task
type: task
scope: 国内站旧版 Agent 左导航的 Bot 状态展示。
triggers: ["Bot 状态头像角标", "Agent 左导航状态"]
owner: LightVela 产品团队
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-05-cn-bot-status-avatar-dot.md
status: active
reviewed_at: 2026-10-05
review_due: 2026-10-19
revision: 1.0.0
precedence: task
derived: false
---

## goal

让国内站 Agent 左导航的正常运行 Bot 用头像右下角绿点表示状态，不再重复显示「运行中」。

## non_goals

- 不改变 Bot 实际状态、国际站状态行、认证、发布或 GitOps。

## requirement_ids / requirement_refs / requirement_excerpt

- 2026-10-05 用户截图反馈；外部需求标识 unknown。截图是「日常／探索」侧栏，要求正常运行状态以头像角标表达，其他状态可用不同颜色点。

## interface_refs / data_structure_refs

- `OpenClawBot["status"]`、`getBotStatusColor`、`getBotStatusLabel`；保持状态来源及原有操作不变。

## history_context

- `current_design_refs`：`frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md`、当前侧栏源码。
- `relevant_evolution`：先前改动落在 Chat First 导航工作树；用户截图对应本工作树的「日常／探索」侧栏，需在此补齐。
- `superseded_refs`：无。

## acceptance

- 国内站运行中 Bot 的头像右下角显示绿点，状态行不显示「运行中」；暂停、失败和过渡状态保留可读文字及颜色点；国际站布局保持原状。
- 本工作树在 5174 端口运行，浏览器可见目标侧栏。

## affected_paths

- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/styles.css`

## required_context

- 路由 Pack：`frontend-product-surface`、`service-frontend`、`site-environment-routing`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
| --- | --- | --- |
| `AGENTS.md@working-tree` | 仓库边界 | 验证与交付要求 |
| `docs/context/project/services/frontend.md@working-tree` | 路由器 must-read | 前端验证范围 |
| `docs/context/domains/site-environment-routing.md@working-tree` | 路由器 must-read | 国内／国际隔离 |
| `frontend/AGENTS.md@working-tree` | 服务规则 | UI 与构建门禁 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@working-tree` | 邻接卡 | 检查相邻测试与 i18n |
| `frontend/src/pages/marketing/agent-settings-page.tsx@working-tree` | 当前实现 | 状态行与头像定位 |
| `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts@working-tree` | 相邻测试 | 保持暂停提示行为 |

## evidence

- 5174 曾由 `cn-chat-welcome-mascot` 工作树提供用户截图中的侧栏；先前预览切到 Chat First 工作树后界面不匹配。
- `pnpm check` 通过（TypeScript 0 新诊断）；侧栏聚焦 Vitest 37/37 通过；`pnpm build:cn` 与 `pnpm build:global` 通过；文档校验 0 错误、0 断链；`git diff --check` 与变更影响检查通过。
- 5174 的监听进程 cwd 为本工作树 `frontend/`，`/agents/overview/` 返回 200。已登录 Chrome 本地页确认「日常／探索」侧栏、头像橙色暂停点、暂停文字和无重复行内圆点；页面无 Next 错误覆盖层。应用内浏览器目前显示登录页，尚不能在其中复核真实运行中 Bot。

## risks

- 当前浏览器账号状态可能无法同时覆盖运行中和异常 Bot；用状态条件与聚焦验证核对，真实运行中页面仍需用户登录态确认。

## validation

- `pnpm check`、聚焦 Vitest、`pnpm build:cn`、`pnpm build:global`、`git diff --check`、浏览器截图及 5174 进程归属检查。

## decisions

- 仅国内站将状态点移到头像；非正常状态保留文字以便识别。依据用户反馈。

## scan_scope

- `frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/src/styles.css`、侧栏相邻测试。

## scan_output

- 有界精确搜索命中 `getBotStatusLabel`、`lv-agent-avatar`、`lv-agent-status-row`，未扩大到无关服务。

## handoff

- 国内站本地预览已在 5174 切至本工作树；用户已授权提交 MR，尚未合并或发布生产。应用内浏览器需要正常登录后才能显示 Bot 侧栏。

## checkpoint

### stage

国内站侧栏状态角标已实现并在本工作树的 5174 预览中验证暂停状态。

### verified

- 截图对应工作树与之前改动工作树不同，5174 曾被前者占用。
- 前端检查、侧栏测试 37/37、双站构建、文档与变更影响检查通过；5174 进程 cwd 正确。
- 已登录 Chrome 本地页呈现「日常／探索」侧栏及头像暂停状态点，无错误覆盖层。

### unverified

- 运行中 Bot 的真实浏览器视觉状态；当前 Chrome 本地账号为暂停 Bot，应用内浏览器需登录。

### discard

- 不再以 Chat First 工作树的浏览器结果代表本截图对应的侧栏。

### restore

- 工作树：`/Users/pablozhong/.codex/worktrees/cn-chat-welcome-mascot/lightvela`。

### next_action

将已验证的左导航改动提交 MR；生产发布仍需单独授权。
