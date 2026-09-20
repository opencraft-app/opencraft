## goal
在最新 `origin/master` 的 Agent 控制台上统一 Setup / Use 导航分组，并按当前有效套餐调整 Model 入口位置。

## non_goals
- 不修改模型配置页、模型读写逻辑或套餐权益。
- 不改变 Launch / Cruise 及套餐未知状态的 Model 可发现性。
- 不合并 MR、不发布或操作生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户本轮请求（2026-09-20）：基于最新 master，将 model、channel、skill、scheduled task 放在同一 Use 分组；Launch AI / Cruise AI 从主导航隐藏 Model，并在左下角用户菜单的 Plan & Billing 后展示 Model；模型页继续保留 Agent 左侧导航。外部需求标识：`unknown`。

## interface_refs / data_structure_refs
- `Pass.bundle_id`：使用当前有效 Pass 的稳定套餐 ID 判断入口位置。
- `AGENT_SECTION_PATH_BY_ID.model`：模型配置页唯一入口路由。
- `getAgentSectionHref`：用户菜单跳转模型页时保留当前 Bot 查询参数。
- 不变量：入口迁移不改变 `/agents/models` 页面渲染和访问能力。

## history_context
- `current_design_refs`：`frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/src/components/site/user-avatar-menu.tsx`、`frontend/src/lib/agent-routes.ts`。
- `relevant_evolution`：最新 master 已包含新版左侧栏、底部账号菜单和 Bot 查询参数持久化；本任务在该结构上做最小修改。
- `superseded_refs`：旧预览 worktree `/Users/pablozhong/codex/lightvela-agent-nav-use-preview`，仅用于识别原始需求，不作为实现基线。

## acceptance
- Channel、Model、Skills、Automations 统一位于一个 Use 分组，不再展示 Setup 分组。
- `bundle_launch_ai_01`、`bundle_cruise_ai_01` 的 Use 分组不显示 Model。
- 上述两个套餐的用户菜单在 Plan & Billing 后显示 Model，并链接模型页。
- 标准套餐或套餐未知时继续在 Use 分组显示 Model，用户菜单不显示重复入口。
- 从用户菜单进入模型页时保留当前 Bot 查询参数，模型页继续渲染 Agent 左侧导航。
- 聚焦测试、前端检查、文档与 diff 检查通过。

## affected_paths
- `frontend/src/lib/agent-routes.ts`
- `frontend/src/lib/__tests__/agent-routes.test.ts`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-labs-nav.test.tsx`
- `frontend/src/components/site/user-avatar-menu.tsx`
- `frontend/src/components/site/__tests__/user-avatar-menu.test.tsx`
- `docs/context/tasks/2026-09-20-agent-navigation-use-ai-model.md`

## required_context
- Pack：`docs/context/domains/agent-gateway-runtime.md`。
- 邻接卡：`docs/context/project/adjacency/frontend-runtime-openspec-i18n.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@ddcaadbad5a6` | 仓库硬边界与 Task Pack 要求 | 约束隔离工作区、验证与交付范围 |
| `frontend/AGENTS.md@ddcaadbad5a6` | 前端服务门禁 | 确定复用策略与检查命令 |
| `frontend/DESIGN.md@ddcaadbad5a6` | 前端设计规范 | 保持既有导航和菜单样式 |
| `docs/context/domains/agent-gateway-runtime.md@2.1.0` | context router 的 must_read | 确认本次只变更前端入口，不改变运行时路由 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 前端邻接检查 | 核对实现、相邻测试与 i18n 边界 |

## evidence
- 基线：`origin/master@ddcaadbad5a60a55d6f3a7a85d744e48d8d27b56`。
- `corepack pnpm@10.23.0 exec vitest run --config vitest.config.ts --api.host 127.0.0.1 ...`：4 个文件、56 条测试通过。
- `corepack pnpm@10.23.0 check`：通过；i18n 错误 0，TypeScript diagnostics 171 current / 276 baseline / 0 new / 105 resolved。
- `git diff --check`：通过。
- `validate_change_impact.py --repo . --staged`（隔离临时 index）：通过，无命中的正式设计映射。
- `validate_documentation.py --repo . --format json`：错误 0、断链 0、警告 0。
- 国际站本地预览由 `/Users/pablozhong/codex/lightvela-agent-nav-use-latest/frontend` 监听 `5174`；Chrome 同登录态页面显示新版 master 的底部账号菜单和新版侧栏，Setup 已移除，Use 依次展示 Channels / Models / Skills / Scheduled Tasks。页面资源来自 Next.js dev `_next/static`，不是生产 `__releases/`。
- 国内站本地预览已切换至同一 worktree 的 `pnpm dev:cn` / `5174`，通过现有 Whistle `lv` 规则映射 `lightvela.com`；Chrome 登录态页面完整加载，使用分组依次展示通道 / 模型 / 技能 / 定时任务，浏览器错误为 0，页面资源来自本地 Next.js dev `_next/static`。

## risks
- 风险：套餐信息尚未加载时 Model 入口消失。缓解：仅精确匹配两个 AI 套餐 ID 时迁移，其他状态保留主导航入口。
- 风险：用户菜单跳转后切换了当前 Bot。缓解：复用 `getAgentSectionHref` 保留 `bot` 查询参数。
- 回滚：移除套餐判断并恢复 Model 为 Use 分组固定入口。

## validation
- 聚焦 Vitest：路由、用户菜单、Agent 导航测试。
- `cd frontend && pnpm check`
- `git diff --check`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`
- 国际站同登录态本地预览。

## decisions
- 以 `bundle_id` 精确匹配 AI 套餐，不使用可本地化套餐名。
- 使用 `Use` 作为统一分组名，沿用产品现有英文信息架构。
- 复用 `/agents/models`，不新增账号子页面。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/components/site/user-avatar-menu.tsx`
- `frontend/src/lib/agent-routes.ts`
- 对应聚焦测试。

## scan_output
- 通过 `settingsGroups|activePass|ACCOUNT_BILLING_PATH|AGENT_SECTION_PATH_BY_ID|bundle_launch_ai_01` 完成最新 master 的有界精确搜索。

## handoff
- 已在最新 master 的隔离 worktree 完成实现、检查与国内/国际站登录态预览；当前预览运行国内站，当前账号为标准 Launch，Model 保留在 Use 分组符合预期。AI 套餐入口迁移由聚焦测试覆盖。
- 交付目标为当前功能分支到 `master` 的 MR；不合并、不发布。
