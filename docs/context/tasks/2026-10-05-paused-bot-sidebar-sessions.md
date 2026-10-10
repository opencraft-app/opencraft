## goal
Bot 已暂停时，Agents 侧栏不再长期显示“正在加载会话”。

## non_goals
- 不改变 Bot 暂停、续费或会话服务端协议。
- 不删除已缓存的会话。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-05 提供国际站 `/agents/` 截图：Bot 标记为 Paused，侧栏仍显示 Loading sessions；要求暂停时不显示该加载提示。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-settings-page.tsx`：`activeBot.status`、侧栏会话列表与 `AgentChatMigrationSurface.preloadSessions`。
- `frontend/src/pages/marketing/agent-sidebar-session-list.ts`：按 Bot 缓存会话与加载状态。

## history_context
- current_design_refs: 运行时页面及相邻测试为本次状态逻辑依据。
- relevant_evolution: 现有侧栏对无缓存 Bot 预设 `loading: true`，暂停时会因无法确认列表而持续显示加载提示。
- superseded_refs: 无。

## acceptance
- 暂停且无会话时，不显示 Loading sessions 或默认会话入口，也不预加载侧栏会话。
- 暂停且已有缓存会话时保留列表；恢复运行后重新遵循加载或空列表规则。
- 聚焦测试、前端静态检查与构建通过。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/agent-sidebar-session-list.ts`
- `frontend/src/pages/marketing/__tests__/agent-sidebar-session-list.test.tsx`

## required_context
- 路由器未命中 Domain Pack；执行了 `frontend/src/pages/marketing` 有界精确搜索。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md` | 前端边界与门禁 | 确认验证要求 |
| `docs/context/tasks/TASK-TEMPLATE.md` | 任务记录格式 | 记录范围与证据 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 前端邻接检查 | 检查相邻测试与词典；本次不新增文案 |
| `frontend/src/pages/marketing/agent-settings-page.tsx` | 侧栏加载条件 | 由 Bot 暂停状态决定空列表占位 |
| `frontend/src/pages/marketing/agent-sidebar-session-list.ts` | 列表缓存与初始加载状态 | 保持缓存会话不被暂停状态清除 |
| `frontend/src/pages/marketing/opencraft-embedded-workbench.tsx` | 预加载消费方 | 暂停时不主动预加载会话 |

## evidence
- `pnpm exec vitest run ...agent-sidebar-session-list.test.tsx ...agent-settings-sidebar-tabs.test.ts ...opencraft-embedded-workbench-preload.cn.test.tsx --reporter=dot`：3 个文件、42 项通过。
- `pnpm check`：通过；TypeScript 166 current / 171 baseline / 0 new，词典原有 47 条告警。
- `pnpm build:global` 与 `pnpm build:cn`：均通过，包含 `/agents` 路由。

## risks
- 暂停时进入聊天页仍可能触发聊天面板自身的启动逻辑；本次只控制侧栏的空列表占位和预加载。恢复后 `preloadSessions` 会重新为真。

## validation
- 聚焦 Vitest、`pnpm check`、双站构建、`git diff --check`。全量 Vitest 在同一 worktree 的前序任务中遇到其他模块失败及 worker OOM，本次以侧栏相关聚焦用例验证。

## decisions
- 只在无会话时抑制暂停态占位；已有会话仍显示。使用现有 Bot 状态，不新增后端请求或翻译。

## scan_scope
- `frontend/src/pages/marketing` 中会话加载提示、Bot 状态与预加载入口。

## scan_output
- 精确命中 `agent-settings-page.tsx` 的侧栏提示及 `agent-sidebar-session-list.ts` 的加载状态。

## handoff
- 已在独立 worktree 完成并通过聚焦验证；本次没有提交、推送或发布授权。
