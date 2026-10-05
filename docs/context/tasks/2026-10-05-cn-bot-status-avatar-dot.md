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
- 2026-10-05 后续要求：创建中、删除中、草稿的灰色状态点闪烁，表示尚在处理中。

## interface_refs / data_structure_refs

- `OpenClawBot["status"]`、`getBotStatusColor`、`getBotStatusLabel`；保持状态来源及原有操作不变。

## history_context

- `current_design_refs`：`frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md`、当前侧栏源码。
- `relevant_evolution`：先前改动落在 Chat First 导航工作树；用户截图对应本工作树的「日常／探索」侧栏，需在此补齐。
- `superseded_refs`：无。

## acceptance

- 国内站运行中 Bot 的头像右下角显示绿点，状态行不显示「运行中」；暂停、失败和过渡状态保留可读文字及颜色点；国际站布局保持原状。
- 国内站创建中、删除中、草稿的灰点循环闪烁；运行中、暂停、失败和重启中的点保持静止；减少动态效果设置下不循环闪烁。
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
- 灰点闪烁改动后 `pnpm check` 通过（TypeScript 0 新诊断），侧栏聚焦 Vitest 37/37、`pnpm build:cn`、`pnpm build:global`、OpenCraft Agent Console 同步检查（130 文件）均通过。

## risks

- 当前浏览器账号状态可能无法同时覆盖运行中和异常 Bot；用状态条件与聚焦验证核对，真实运行中页面仍需用户登录态确认。
- 当前账号未必有创建中、删除中或草稿 Bot；需用状态条件和 CSS 动画检查覆盖，真实状态视觉仍待遇到相应 Bot 时点验。

## validation

- `pnpm check`、聚焦 Vitest、`pnpm build:cn`、`pnpm build:global`、`git diff --check`、浏览器截图及 5174 进程归属检查。

## decisions

- 仅国内站将状态点移到头像；非正常状态保留文字以便识别。依据用户反馈。
- 仅灰色状态点增加透明度闪烁；已有全局 `prefers-reduced-motion` 规则禁用持续动画。

## scan_scope

- `frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/src/styles.css`、侧栏相邻测试。

## scan_output

- 有界精确搜索命中 `getBotStatusLabel`、`lv-agent-avatar`、`lv-agent-status-row`，未扩大到无关服务。

## handoff

- 国内站本地预览已在 5174 切至本工作树；本次闪烁效果准备更新现有 MR !4997，尚未合并或发布生产。应用内浏览器需要正常登录后才能显示 Bot 侧栏。

## checkpoint

### stage

国内站灰色状态角标闪烁已实现并通过前端门禁，待更新 MR !4997。

### verified

- 截图对应工作树与之前改动工作树不同，5174 曾被前者占用。
- 前端检查、侧栏测试 37/37、双站构建、文档与变更影响检查通过；5174 进程 cwd 正确。
- 已登录 Chrome 本地页呈现「日常／探索」侧栏及头像暂停状态点，无错误覆盖层。
- 灰点闪烁改动后的前端检查、侧栏测试 37/37、双站构建及 OpenCraft 同步检查通过。

### unverified

- 运行中 Bot 的真实浏览器视觉状态；当前 Chrome 本地账号为暂停 Bot，应用内浏览器需登录。
- 创建中、删除中、草稿的真实浏览器视觉状态；当前账号暂无这些状态。

### discard

- 不再以 Chat First 工作树的浏览器结果代表本截图对应的侧栏。

### restore

- 工作树：`/Users/pablozhong/.codex/worktrees/cn-chat-welcome-mascot/lightvela`。

### next_action

将已验证的闪烁效果推送到现有 MR !4997 并核验远端；生产发布仍需单独授权。
