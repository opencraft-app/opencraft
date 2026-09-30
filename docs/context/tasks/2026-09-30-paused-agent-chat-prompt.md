## goal
Agent 已暂停时，聊天区显示暂停提示，不提示连接自动恢复，也不提供手动重连。

## non_goals
- 不改变 Agent 暂停、续费或恢复运行的服务端流程。
- 不调整运行中 Agent 的连接恢复策略或聊天记录。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户截图与本次请求：侧栏为「已暂停」时，聊天区不应显示「连接暂时中断，正在尝试恢复…」。

## interface_refs / data_structure_refs
- Agent 实例暂停时 `/bots` 被跳过，默认 Bot 从 `/v1/instances` 投影而来，带 `status: paused` 与 `siblingsUnknown: instance_stopped`；运行中的 Agent 下，Bot 的 `status` 也可能独立为 `paused`。
- `AgentChatMigrationSurface` 只消费父页面判定的 `agentPaused`，不从连接错误或单独的 Bot 状态推断 Agent 状态。
- `opencraft-connection` 仅报告连接阶段和失败码，不提供 Agent 运行状态。

## history_context
- current_design_refs: `frontend/AGENTS.md`、`docs/context/project/services/frontend.md`、`docs/context/domains/site-environment-routing.md`。
- relevant_evolution: 侧栏已有「Agent 已暂停运行。如因套餐到期，续费后即可恢复使用。」及双站 locale 翻译。
- superseded_refs: 无。

## acceptance
- 已暂停时，聊天区显示暂停提示且无「重新连接」按钮；运行中断线仍可手动重连。
- 聚焦组件测试、`pnpm check`、`pnpm build` 通过；记录全量测试结果。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/opencraft-embedded-workbench.tsx`
- `frontend/src/pages/marketing/__tests__/opencraft-embedded-workbench.test.tsx`
- `frontend/src/repositories/__tests__/http-repositories.test.ts`

## required_context
- `frontend-product-surface`、`service-frontend`、`site-environment-routing`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@HEAD` | 最近服务规则 | 确认前端验证门禁 |
| `docs/context/project/services/frontend.md@HEAD` | 路由 must_read | 前端权威与范围 |
| `docs/context/domains/site-environment-routing.md@HEAD` | 路由 must_read | 双站 locale 范围 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@HEAD` | 邻接卡 | 检查组件测试与现有翻译 |
| `frontend/openspec/specs/agents-workbench.md@HEAD` | OpenSpec 邻居 | 确认并非同一聊天承载面 |
| `frontend/src/i18n/t.ts@HEAD` | i18n 邻居 | 复用已有翻译键 |

## evidence
- 截图中侧栏「已暂停」，聊天区显示「连接暂时中断，正在尝试恢复…」与「重新连接」。
- `rg` 定位提示为 `opencraft-embedded-workbench.tsx`，现有测试覆盖运行中断线重连。
- 首轮聚焦 Vitest：8/8 通过；区分 Agent 与 Bot 状态后，两个聚焦文件 90/90 通过。`pnpm check`：通过、0 条新增 TypeScript 诊断；首轮 `pnpm build`：通过。
- 全量 `pnpm test` 首次因本机 `localhost` DNS 解析失败而未启动。以 `--api.host 127.0.0.1` 重试后，模型配置、套餐、自动化等无关模块出现大量失败，停止该轮全量测试。
- 变更路径不命中 `.agents/context/change-impact.json` 的任何规则；无需正式设计文档同步或 staged 变更影响检查。

## risks
- 暂停状态延迟更新时，UI 仍依赖父页面当前 Bot 状态；状态刷新后恢复正确显示。

## validation
- 聚焦 Vitest、`pnpm check`、`pnpm build` 已通过；全量测试未通过。

## decisions
- 仅在 `activeBot.status === "paused" && activeBot.siblingsUnknown === "instance_stopped"` 时判定 Agent 实例暂停；单独的 Bot 暂停不触发 Agent 提示。
- 复用侧栏已有暂停文案与翻译键。

## scan_scope
- `frontend/src/pages/marketing/`、相关组件测试与 i18n 键。

## scan_output
- `rg` 输出已用于定位，无需保留完整扫描产物。

## handoff
- MR !4872 已创建，目标 `master`；创建时为 `opened` / `can_be_merged`，CI `pending` 且阻塞。尚未合并或发布。
