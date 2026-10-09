## goal
将 Agent 侧边栏「日常」导航中的连接器移到技能下方。

## non_goals
- 不改变连接器可见条件、路由、面板行为或其他导航组。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-09 请求及截图：连接器放在技能下面。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-settings-page.tsx` 的 `settingsGroups`；保持 `showConnectorsEntry` 条件和路径不变。

## history_context
- `current_design_refs`：`frontend/DESIGN.md`；当前菜单顺序以源码为准。
- `relevant_evolution`：连接器入口已存在于 `origin/master` 的「日常」组。
- `superseded_refs`：无。

## acceptance
- 连接器可见时，顺序为通道、技能、连接器、定时任务；不可见时，原有其他项顺序不变。
- 通过导航顺序测试和前端适用门禁。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`

## required_context
- `frontend-product-surface`、`service-frontend`、`site-environment-routing`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@origin/master` | 前端服务边界 | 确定验证范围 |
| `docs/context/domains/site-environment-routing.md@origin/master` | 连接器有区域可见条件 | 保留国内站门禁 |
| `frontend/AGENTS.md@origin/master` | 前端规则 | 确定检查命令 |
| `frontend/DESIGN.md@origin/master` | UI 导航规则 | 不改导航样式 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@origin/master` | 前端相邻文件 | 检查现有顺序测试与 OpenSpec |
| `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md@origin/master` | 相关历史 | 确认设置导航结构 |

## evidence
- `origin/master` 中 `settingsGroups` 原顺序为通道、连接器、技能、定时任务；现已交换技能与连接器。
- `pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`：8/8 通过。
- `pnpm check`：通过，i18n 结构错误 0，TypeScript 新增诊断 0。
- `pnpm build`：通过，静态路由包含 `/agents/connectors`。
- `pnpm test`：多处无关测试失败，worker 达到 Node 4GB 堆上限后中止；未取得全量通过结果。
- `npm --prefix opencraft run check:mono2-agent-console`：失败，清单 `sourceRevision` 与当前源码修订不一致；按前端规则，真源提交后才能同步副本。
- `pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.tsx`：启动时本机 `localhost` DNS `ENOTFOUND`，未运行用例。
- `git diff --check`：通过。

## risks
- 菜单只在原有条件满足时显示连接器；保留该条件可直接回滚本次顺序变化。

## validation
- 导航顺序测试；`pnpm check`、`pnpm test`、`pnpm build`；OpenCraft 同步只读检查；`git diff --check`。

## decisions
- 只调整 `sections` 数组中的项序，并更新现有顺序断言；不引入新的导航配置层。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx` 及相邻测试、相关 OpenSpec。

## scan_output
- 精确搜索命中 `settingsGroups` 和 `agent-settings-nav-order.test.ts`。

## handoff
- 导航顺序已调整，聚焦测试、前端检查和构建通过；全量测试与 OpenCraft 同步检查未通过。未提交、未推送、未发布。
