## goal
按 AI 与非 AI 套餐调整 Agent 控制台左下角账号菜单顺序，并保持国内站与国际站各语言一致。

## non_goals
- 不改变入口的显示条件、链接、文案、顶部 Header 菜单及退出登录。
- 不合并 MR 或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户本轮截图与要求（2026-09-25）：左下角选项框依次为 Models、Plan & Billing、Account、Language；外部需求标识 `unknown`。
- 用户后续确认：非 AI 套餐无此处 Models 入口，顺序为 Plans & billing、Account、Language；国内站与国际站各语言均需核对。

## interface_refs / data_structure_refs
- `UserAvatarMenu` 的 `variant="sidebar"`、`showModelEntry` 与 `showLanguageSwitcher`；AI 套餐才显示 Models，国际站才显示 Language。

## history_context
- `current_design_refs`：`docs/engineering/domains/site-environment-routing.md`、`frontend/openspec/changes/2026-09-14-global-agents-account-language-switcher-design.md`。
- `relevant_evolution`：主干已有左侧账号菜单与语言二级菜单；本轮只重排一级入口。
- `superseded_refs`：无。

## acceptance
- AI 套餐的左侧账号菜单依次为 Models、Plans & billing、Account、Language；非 AI 套餐依次为 Plans & billing、Account、Language。国内站均不显示 Language，退出登录仍在分隔线下。
- 国内站与国际站所有已开放语言共用上述顺序。
- 顶部 Header 的账号菜单顺序不变；既有显示条件不变。
- 聚焦组件测试与前端门禁通过。

## affected_paths
- `frontend/src/components/site/user-avatar-menu.tsx`
- `frontend/src/components/site/__tests__/user-avatar-menu.test.tsx`
- `docs/engineering/domains/site-environment-routing.md`

## required_context
- `service-frontend`、`site-environment-routing`、`frontend-product-surface`；邻接卡 `frontend-runtime-openspec-i18n`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库边界 | Task Pack 与验证要求 |
| `frontend/AGENTS.md@working-tree` | 前端边界 | 聚焦测试与构建门禁 |
| `docs/context/project/services/frontend.md@2.1.0` | 路由 must_read | 确认服务范围 |
| `docs/context/domains/site-environment-routing.md@2.0.0` | 路由 must_read | 确认双站边界 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 邻接卡 | 检查 OpenSpec、测试及 i18n 入口 |
| `frontend/openspec/changes/2026-09-14-global-agents-account-language-switcher-design.md@working-tree` | 当前设计 | 保留语言菜单显示条件与交互 |
| `frontend/src/i18n/index.ts@working-tree` | 语言邻居 | 确认本轮无文案生成变更 |

## evidence
- `pnpm exec vitest run --config vitest.config.ts src/components/site/__tests__/user-avatar-menu.test.tsx`：43/43 通过，覆盖国内站与国际站 7 个已开放语言的 AI/非 AI 套餐顺序、国内站无 Language 及 Header 原顺序。
- `pnpm exec vitest run --config vitest.config.ts src/lib/__tests__/agent-plan-navigation.test.ts src/pages/marketing/__tests__/agent-settings-labs-nav.test.tsx src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`：25/25 通过，确认非 AI 套餐模型入口仍在 Agent 主导航。
- `pnpm check`：通过；i18n 错误 0，TypeScript 171 current / 171 baseline / 0 new。
- `pnpm build`、`pnpm build:global`：均通过；构建生成的字体差异已还原。
- `pnpm test`：全量套件在模型配置、自动任务、文档等非菜单文件出现多处失败，且之后长时间未退出，已中断；不记为通过。
- `validate_documentation.py --repo . --format json`：错误 0、断链 0、警告 0。
- `validate_change_impact.py --repo . --staged`（隔离临时 index）与 `git diff --check`：通过。

## risks
- 共用菜单可能影响 Header；按 `variant` 保留 Header 顺序，并在组件测试中检查。

## validation
- `pnpm exec vitest run --config vitest.config.ts src/components/site/__tests__/user-avatar-menu.test.tsx`
- `pnpm check`、`pnpm test`、`pnpm build`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- `git diff --check`

## decisions
- 只调整一级菜单 DOM 顺序，不改变 CSS 或语言二级菜单；owner：本轮实现。

## scan_scope
- `frontend/src/components/site/user-avatar-menu.tsx` 及其相邻测试、相关 OpenSpec。

## scan_output
- 精确搜索 `showModelEntry`、`套餐与费用`、`语言` 命中实现和组件测试。

## handoff
- 菜单顺序、聚焦测试、前端检查、双站构建与文档门禁已完成；全量套件存在非菜单文件失败。
- 工作分支为 `codex/account-menu-order`；合并与发布不在本次范围。
