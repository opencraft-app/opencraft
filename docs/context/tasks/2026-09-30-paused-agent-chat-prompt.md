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
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/UPSTREAM.json`（CI 生成闭包修复）

## required_context
- `frontend-product-surface`、`service-frontend`、`site-environment-routing`。
- `service-opencraft`、`upstream-subtrees`、`agent-gateway-runtime`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@HEAD` | 最近服务规则 | 确认前端验证门禁 |
| `docs/context/project/services/frontend.md@HEAD` | 路由 must_read | 前端权威与范围 |
| `docs/context/domains/site-environment-routing.md@HEAD` | 路由 must_read | 双站 locale 范围 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@HEAD` | 邻接卡 | 检查组件测试与现有翻译 |
| `frontend/openspec/specs/agents-workbench.md@HEAD` | OpenSpec 邻居 | 确认并非同一聊天承载面 |
| `frontend/src/i18n/t.ts@HEAD` | i18n 邻居 | 复用已有翻译键 |
| `opencraft/AGENTS.md@HEAD` | OpenCraft 服务规则 | 生成闭包与验证门禁 |
| `opencraft/MONO2_MIGRATION.md@HEAD` | 同步契约 | 只同步 mono2 前端真源 |
| `docs/context/project/services/opencraft.md@HEAD` | 路由 must_read | OpenCraft 服务边界 |
| `docs/context/project/upstream-subtrees.md@HEAD` | 路由 must_read | mono2 唯一写入真源 |
| `docs/context/domains/agent-gateway-runtime.md@HEAD` | 路由 must_read | Agent 运行域范围 |
| `docs/context/flows/tapd-gongfeng-delivery.md@origin/master` | MR 冲突修复路由 | 确认提交与推送授权边界 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@origin/master` | OpenCraft 维护路由 | 选择嵌入聊天验证范围 |
| `opencraft/docs/chat-ui-architecture.md@origin/master` | 当前聊天契约 | 保留模板投递、草稿和重连语义 |
| `opencraft/docs/platform-architecture.md@origin/master` | 当前平台边界 | 不修改 Host 或会话所有权 |

## evidence
- 截图中侧栏「已暂停」，聊天区显示「连接暂时中断，正在尝试恢复…」与「重新连接」。
- `rg` 定位提示为 `opencraft-embedded-workbench.tsx`，现有测试覆盖运行中断线重连。
- 首轮聚焦 Vitest：8/8 通过；区分 Agent 与 Bot 状态后，两个聚焦文件 90/90 通过。`pnpm check`：通过、0 条新增 TypeScript 诊断；首轮 `pnpm build`：通过。
- 全量 `pnpm test` 首次因本机 `localhost` DNS 解析失败而未启动。以 `--api.host 127.0.0.1` 重试后，模型配置、套餐、自动化等无关模块出现大量失败，停止该轮全量测试。
- 变更路径不命中 `.agents/context/change-impact.json` 的任何规则；无需正式设计文档同步或 staged 变更影响检查。
- MR !4872 首轮 CI 日志显示 OpenCraft `sourceRevision` 漂移；合并 `origin/master@3e8d3f690` 后，官方同步仅更新 `UPSTREAM.json`，130 个 vendored 文件检查通过。
- 同步后的 OpenCraft 嵌入式 CI 测试 142/142、前端聚焦测试 90/90、前端 guard 测试 130/130、`pnpm check` 与 CN/global build 均通过。
- 额外的 OpenCraft `npm run gate` 在 `test:extensions` 的测试输出后长期未退出，已停止；不把完整 gate 记为通过。本次 CI 对应的 `check:mono2-agent-console` 与 `test:embedded-ci` 已单独通过。
- 目标分支后续合入 `da1f500cb`，其中 `sync-mono2-agent-console.mjs` 改为只追踪实际复制的源文件；二次合并后官方同步把 manifest `sourceRevision` 从目标上的 `414ca8fe6` 更新为 `2a65b0388`，130 个文件检查通过。
- 二次合并后 `pnpm check` 为 0 条新增 TypeScript 诊断，相关与 guard 测试合计 221/221，CN/global build 均通过。
- 2026-10-02 对照 `origin/master@b42d361c7` 解决冲突：新版 `opencraft-embedded-workbench.cn.test.tsx` 已接收暂停态回归；组件沿用主线的模板投递、草稿和启动逻辑，仅保留暂停提示/禁用重试；`UPSTREAM.json` 由官方同步脚本生成并检查 130 个文件。
- 最新主线的 `opencraft/docs/chat-ui-architecture.md` 明确要求嵌入模板经 `submitPrompt` 进入 Host，已有会话和草稿不可被覆盖；合并结果保留相关入口。暂停/恢复切换的组件测试仍断言同一元素与未发送草稿保留。

## risks
- 暂停状态延迟更新时，UI 仍依赖父页面当前 Bot 状态；状态刷新后恢复正确显示。

## validation
- 聚焦 Vitest、`pnpm check`、CN/global build、OpenCraft 生成检查与 embedded CI 测试已通过；前端全量测试未通过，OpenCraft 完整 gate 未完成。
- 2026-10-02：当前主线合并工作树上的前端聚焦测试 145/145、`pnpm check`、`pnpm build` 通过；OpenCraft `test:embedded-ci` 155/155、Web typecheck、`build:web`、130 文件生成检查通过；`git diff origin/master --check`、文档检查通过。前端全量 `pnpm test` 在多个未触及模块失败，一名 worker 达到约 4 GB 内存上限，随后停止，不记为通过。

## decisions
- 仅在 `activeBot.status === "paused" && activeBot.siblingsUnknown === "instance_stopped"` 时判定 Agent 实例暂停；单独的 Bot 暂停不触发 Agent 提示。
- 复用侧栏已有暂停文案与翻译键。

## scan_scope
- `frontend/src/pages/marketing/`、相关组件测试与 i18n 键。

## scan_output
- `rg` 输出已用于定位，无需保留完整扫描产物。

## handoff
- MR !4872 已在隔离工作树本地合入 `origin/master@b42d361c7` 并解决冲突，当前仍处于未提交的 Git merge 状态。提交合并前需取得用户明确授权；提交后必须重新运行 `sync:mono2-agent-console` 和 `check:mono2-agent-console`，确认 `sourceRevision` 基于已提交的合并历史，再推送并核对 MR source SHA、冲突与 CI。尚未合并 MR 或发布。
