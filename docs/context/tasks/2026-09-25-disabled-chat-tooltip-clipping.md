## goal
修复 Agent 左侧栏禁用 Chat Tab 的 hover/focus 提示被滚动容器裁切。

## non_goals
- 不更改 Chat 可用性、禁用条件、提示文案、Tab 导航及其他提示。
- 不合并 MR 或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户截图及本轮要求（2026-09-25）：Chat 不能点击时，hover 提示被遮挡；外部需求标识 `unknown`。

## interface_refs / data_structure_refs
- `AgentSettingsPage` 中的 `isChatTabDisabled`、`showBuddyOnboarding` 与 `WorkspaceActionTooltip`。
- 不变量：禁用按钮不可点击；键盘聚焦可读取原因；启用时不显示原因提示。

## history_context
- `current_design_refs`：`frontend/DESIGN.md` 的 Tooltip 交互规范、`docs/engineering/domains/site-environment-routing.md` 的侧栏提示边界。
- `relevant_evolution`：侧栏顶部操作已使用 Portal 提示；Chat Tab 仍使用侧栏内绝对定位提示。
- `superseded_refs`：无。

## acceptance
- 禁用 Chat 的提示在侧栏外可完整显示，窄视口内不越界；hover 与键盘聚焦均可触发。
- Chat 的可用性、文案及 Tab 点击逻辑不变；国内站与国际站共用实现。
- 聚焦测试、前端检查与构建通过。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tooltip.test.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `frontend/src/styles.css`
- `docs/engineering/domains/site-environment-routing.md`

## required_context
- `service-frontend`、`site-environment-routing`、`frontend-product-surface`；邻接卡 `frontend-runtime-openspec-i18n`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库规则 | Task Pack 与验证要求 |
| `frontend/AGENTS.md@working-tree` | 前端规则 | 测试与构建门禁 |
| `docs/context/project/services/frontend.md@2.1.0` | 路由 must_read | 确认服务范围 |
| `docs/context/domains/site-environment-routing.md@2.0.0` | 路由 must_read | 确认双站共用前端 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 邻接卡 | 检查 OpenSpec、测试与 i18n 邻居 |
| `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md@working-tree` | 当前交互设计 | 保留 Tab 导航与禁用逻辑 |
| `frontend/DESIGN.md@working-tree` | Tooltip 规范 | 保留可复制、hover/focus 行为 |

## evidence
- 聚焦测试：38/38 通过；覆盖 Portal、窄视口定位、禁用 Chat 的 hover/focus 和侧栏结构。
- `pnpm check`：通过；i18n 错误 0，TypeScript 171 current / 171 baseline / 0 new。
- `pnpm build` 与 `pnpm build:global`：均通过；构建生成的字体差异已还原。
- `validate_documentation.py --repo . --format json`：错误 0、断链 0、警告 0。
- `validate_change_impact.py --repo . --staged` 与 `git diff --check`：通过。

## risks
- Portal 提示需保持禁用按钮的键盘说明；复用现有 `WorkspaceActionTooltip` 并测试焦点与 ARIA 关联。

## validation
- `pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/agent-settings-sidebar-tooltip.test.tsx src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `pnpm check`、`pnpm build`、`pnpm build:global`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- `git diff --check`

## decisions
- 复用现有 Portal 提示组件，增加布局类名入口；owner：本轮实现。

## scan_scope
- `agent-settings-page.tsx` 的 Chat Tab 与 `WorkspaceActionTooltip`，相邻测试、`styles.css`。

## scan_output
- 精确搜索 `chatAvailabilityTooltipId` 与 `.lv-agent-action-tooltip` 定位侧栏内绝对定位提示及其样式。

## handoff
- 代码、聚焦测试和前端门禁已完成；本变更追加至现有 MR !4662。合并与发布不在本次范围。
