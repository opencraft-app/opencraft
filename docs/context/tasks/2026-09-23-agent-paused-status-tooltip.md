## goal
为 Agent 侧边栏的“已暂停”状态补充可访问的悬浮提示，说明续费后会自动恢复运行。

## non_goals
- 不修改实例/Bot 状态来源、续费流程、恢复逻辑或后端接口。
- 不合并 MR、发布或变更生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户对话（2026-09-23）：状态为“已暂停”时，悬浮显示“套餐已到期，Agent 已暂停运行，续费后会自动恢复。”

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-settings-page.tsx` 的 `activeBot.status`：仅 `paused` 状态显示提示。
- `WorkspaceActionTooltip`：复用 Portal、hover/focus、Escape 与 ARIA 行为。

## history_context
- `current_design_refs`：`frontend/DESIGN.md`、`docs/context/domains/subscription-entitlements.md`。
- `relevant_evolution`：生产环境已由用户验证，续费后实例会恢复为运行中。
- `superseded_refs`：无。

## acceptance
- “已暂停”可通过鼠标悬浮和键盘聚焦在状态下方显示指定文案，Escape 可关闭。
- 非暂停状态不显示该提示。
- 提示通过 Portal 渲染，不受侧边栏滚动容器裁切。
- 聚焦测试、i18n 检查和前端检查通过。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `frontend/src/i18n/generated/*.json`
- `docs/context/tasks/2026-09-23-agent-paused-status-tooltip.md`

## required_context
- `subscription-entitlements`
- `frontend-product-surface`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@origin/master` | 仓库边界与验证要求 | 隔离工作树、Task Pack、验证范围 |
| `frontend/AGENTS.md@origin/master` | 前端约束 | 测试与生成式 i18n 要求 |
| `frontend/DESIGN.md@origin/master` | Tooltip 交互规范 | 复用 Portal Tooltip 与键盘交互 |
| `docs/context/domains/subscription-entitlements.md@origin/master` | 续费与权益边界 | 保持前端仅展示，不改变恢复逻辑 |
| `docs/context/project/services/frontend.md@origin/master` | 前端产品面约束 | 确认国内站/国际站共享组件与验证范围 |

## evidence
- `pnpm vitest run --api.host 127.0.0.1 src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts src/pages/marketing/__tests__/agent-settings-sidebar-tooltip.test.tsx src/i18n/__tests__/dictionaries.test.ts`：3 个文件、55 个测试通过；`--api.host` 仅用于绕过本机 `localhost` DNS 解析异常，未写入配置。
- `pnpm i18n:check`：6 个待翻译语种均无缺失。
- `pnpm check`：通过；TypeScript diagnostics 为 171 current / 171 baseline，0 new。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`：通过，无命中规则。
- `git diff --check`：通过。
- 本地 `http://127.0.0.1:5174/agents/` 模拟 `paused` 状态并聚焦提示：Tooltip 在状态下方完整显示；Portal 层级高于侧边栏导航和主内容，未被裁切或遮挡。截图：`/Users/pablozhong/.codex/visualizations/2026/09/23/01a0ccff-be5e-7c01-9e8b-932cbf6a847e/paused-status-tooltip-bottom.jpg`。

## risks
- 风险：长文案在侧边栏内被裁切。缓解：复用 Portal Tooltip，并限制视口宽度。
- 风险：共享页面新增中文文案导致国际站缺译。缓解：生成并补齐全部已注册语言。
- 回滚：移除状态 Tooltip 包装与对应字典项。

## validation
- `pnpm vitest run --api.host 127.0.0.1 src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts src/pages/marketing/__tests__/agent-settings-sidebar-tooltip.test.tsx src/i18n/__tests__/dictionaries.test.ts`
- `pnpm i18n:check`
- `pnpm check`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`

## decisions
- 直接复用 `WorkspaceActionTooltip`，不新增 Tooltip 实现；在状态下方显示，并继续通过 `document.body` Portal 避免被页面容器遮挡。
- 仅以 `activeBot.status === "paused"` 控制文案，保持现有状态映射不变。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/`

## scan_output
- 无独立扫描产物。

## handoff
- 已完成实现与本地验证；本任务授权范围包含 commit、push 和创建 MR，不包含合并或发布。
