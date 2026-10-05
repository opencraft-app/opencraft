## goal
国际站从 Agents 返回首页后，顶部登录账号只显示一个头像菜单。

## non_goals
- 不调整账号菜单内容、登录流程或 Agents 页面布局。
- 不提交、发布或变更生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-05 截图反馈：从 `/agents/` 点击左上角 LightVela Logo 返回首页后，右上角出现两个头像。

## interface_refs / data_structure_refs
- `PublicHeaderAuthIsland` 的登录态、语言切换与产品入口。
- `InternationalHomeRuntime` 的 `international-home-header-actions-layer` 容器。

## history_context
- `current_design_refs`：`docs/context/project/services/frontend.md`、`docs/context/domains/site-environment-routing.md`、`docs/context/domains/identity-access.md`。
- `relevant_evolution`：国际站首页静态片段外层使用 React header actions；当前登录态同时创建桌面与移动头像节点。
- `superseded_refs`：无。

## acceptance
- 登录态首页 DOM 只有一个 `UserAvatarMenu`，桌面和移动宽度均可显示。
- 已订阅产品入口保持原路径和按屏宽的埋点参数。
- 前端测试、检查与构建门禁通过。

## affected_paths
- `frontend/next-site/public-header-auth-island.tsx`
- `frontend/next-site/__tests__/public-header-auth-island.test.tsx`

## required_context
- `validate_context.py --route 'international homepage duplicate account avatars after navigating from Agents via LightVela sidebar logo'` 无匹配；按 `frontend/next-site/public-header-auth-island.tsx` 路由命中 frontend、site-environment-routing、identity-access。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md` | 最近服务规则 | 明确前端门禁与 UI 验证 |
| `docs/context/project/services/frontend.md` | frontend 服务边界 | 确认页面入口与验证范围 |
| `docs/context/domains/site-environment-routing.md` | 国际站路由 | 确认仅调整首页展示 |
| `docs/context/domains/identity-access.md` | 登录态边界 | 保留已有认证状态判断 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 前端邻接卡 | 检查测试邻居 |
| `docs/context/tasks/TASK-TEMPLATE.md` | Task Pack 模板 | 记录任务状态 |
| `/Users/pablozhong/.codex/skills/karpathy-guidelines/SKILL.md` | 代码修改规则 | 最小局部改动 |

## evidence
- 无 Pack 首次精确搜索：`rg UserAvatarMenu frontend/next-site frontend/src/components/site` 定位到首页和共享头像组件。
- `PublicHeaderAuthIsland` 登录态原来同时渲染桌面、移动两份 `UserAvatarMenu`；静态首页只挂载一个 auth island。
- 首页相关 Vitest 3 文件 101/101 通过，覆盖唯一头像及桌面/移动埋点。
- `pnpm check`、`pnpm build:global`、`pnpm build:cn`、`git diff --check`、文档校验通过。
- `pnpm test` 全量运行出现多处非本改动文件失败及 worker OOM，已中止；不能声明全量测试通过。

## risks
- 单节点需继续保持响应式尺寸和移动端埋点；通过组件测试及构建核对。回滚本任务两处前端改动即可。

## validation
- `pnpm exec vitest run next-site/__tests__/public-header-auth-island.test.tsx next-site/__tests__/international-home-rendering.test.tsx next-site/__tests__/international-home-page.test.tsx`：101/101 通过。
- `pnpm check`：通过。
- `pnpm test`：全量未通过，见 evidence。
- `pnpm build:global`、`pnpm build:cn`：均通过。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：通过。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`：通过（无 staged 文件）。

## decisions
- 登录态只创建一份头像及产品入口，以响应式样式改变尺寸；点击时按视口宽度记录原有 desktop/mobile 埋点。避免依赖两份 DOM 的显隐互斥。

## scan_scope
- `frontend/next-site/`、`frontend/src/components/site/` 中的首页认证控件引用。

## scan_output
- 仅保留精确命令摘要，无扫描产物。

## handoff
- 本地修复和聚焦验证完成。全量测试受其他失败及 OOM 限制；未提交、推送或发布。
