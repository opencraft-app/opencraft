## goal
将 `/agents` 的云存储入口从左侧导航迁入左下角账号头像菜单，并置于“套餐与费用”之前。

## non_goals
- 不修改云存储页面、路由、权限、计费或数据接口。
- 不改变公共页头像菜单或其他导航入口。
- 不提交、推送、创建 MR、发布或部署。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户请求（2026-09-28）：`/agents页面，云存储的入口，从左边导航，挪到页面左小角吧，需要点开账号头像才打开；放在“套餐与费用”上面。`

## interface_refs / data_structure_refs
- `frontend/src/lib/agent-routes.ts#AGENT_SECTION_PATH_BY_ID.files`：云存储保留 `/agents/files` 路由。
- `frontend/src/lib/agent-routes.ts#getAgentSectionHref`：保留当前 Agent 的已允许查询参数。

## history_context
- `current_design_refs`：`frontend/AGENTS.md`；`frontend/openspec/specs/auth.md` 的登录后头像菜单入口说明。
- `relevant_evolution`：`frontend/openspec/plan.md` 已有侧栏头像菜单与 Agent 导航的相邻测试约束。
- `superseded_refs`：无。

## acceptance
- `/agents` 左侧导航不再展示“云存储”。
- 点击左下角账号头像后，菜单在“套餐与费用”正上方展示“云存储”，链接保持 `/agents/files` 及允许的查询参数。
- 组件测试、导航顺序测试、类型检查和变更集检查通过。

## affected_paths
- `frontend/src/components/site/user-avatar-menu.tsx`
- `frontend/src/components/site/__tests__/user-avatar-menu.test.tsx`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`

## required_context
- 路由器 query `/agents sidebar cloud storage avatar menu` 未命中 Pack；按要求执行有界精确搜索。
- `frontend/AGENTS.md`、`docs/context/project/services/frontend.md`、`docs/context/project/adjacency/frontend-runtime-openspec-i18n.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@cd7b64cc4` | 前端实现与视觉验证规则 | 限定为小范围 UI/测试改动。 |
| `docs/context/project/services/frontend.md@cd7b64cc4` | 前端服务边界 | 确认双站与测试门禁。 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@cd7b64cc4` | 前端邻接卡 | 确认读取既有实现和相邻测试；不新增翻译。 |
| `frontend/src/components/site/user-avatar-menu.tsx@cd7b64cc4` | 目标账号菜单实现 | 仅新增侧栏云存储入口并改为点击开关。 |
| `frontend/src/pages/marketing/agent-settings-page.tsx@cd7b64cc4` | 原侧栏入口与菜单挂载处 | 删除 `files` 导航项，保留路由/页面。 |

## evidence
- `validate_context.py --route "/agents sidebar cloud storage avatar menu"`：无 Pack 命中。
- 有界搜索：`rg -n -i 'cloud storage|云存储|user-avatar-menu|AGENT_SECTION_PATH_BY_ID' frontend/src frontend/openspec`。
- `.agents/context/change-impact.json` 未命中受影响路径；不需要正式设计文档同步。
- `pnpm exec vitest run src/components/site/__tests__/user-avatar-menu.test.tsx src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`：2 files / 51 tests passed。
- `pnpm check`：i18n 结构检查通过，TypeScript 171 current / 171 baseline / 0 new。
- `validate_change_impact.py --changed-file ...`、`validate_documentation.py --repo . --format json`、`validate_context.py --build-catalog`、`git diff --check`：均 exit 0。

## risks
- 菜单顺序或 Bot 查询参数回归；用组件测试覆盖 AI/标准套餐与查询参数。
- 点击菜单后的关闭行为回归；保留既有外部点击和导航关闭逻辑。

## validation
- `pnpm exec vitest run src/components/site/__tests__/user-avatar-menu.test.tsx src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`
- `pnpm check`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- `git diff --check`

## decisions
- 仅 `variant="sidebar"` 显示云存储，确保“页面左小角”不影响公共页头像菜单。
- 采用已有的 `Files` 图标和 `/agents/files` 路由，不引入新文案或组件。

## scan_scope
- `frontend/src/components/site/`、`frontend/src/pages/marketing/`、`frontend/src/lib/`、`frontend/openspec/`。

## scan_output
- 目标入口位于 `agent-settings-page.tsx` 的 `manage` 分组；账号菜单由 `UserAvatarMenu variant="sidebar"` 挂载。

## handoff
- 已完成并在隔离 worktree 验证；用户尚未授权 Git/MR/发布操作。
