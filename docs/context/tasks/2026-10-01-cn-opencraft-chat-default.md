## goal
国内站的 Agent 对话默认使用 OpenCraft，无需调用 `show()`。

## non_goals
- 不调整国际站 AgentChat、其他隐藏工具或生产发布流程。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户本轮要求（2026-10-01）：国内现网 Chat 直接以 OpenCraft 为默认工具，取消 `show()` 门槛。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-settings-page.tsx` 的 `openCraftChatEnabled`、`AgentChatMigrationSurface`、AgentChat launch-token effect。
- `frontend/src/pages/marketing/opencraft-embedded-workbench.tsx` 的 `enabled` 与 session ownership；保持启动、重连及身份替换逻辑。
- `frontend/release-matrix.json` 已为国内生产组合配置同源内嵌制品路径。

## history_context
- current_design_refs: `docs/engineering/domains/site-environment-routing.md`、`docs/engineering/domains/agent-gateway-runtime.md`、`opencraft/docs/platform-architecture.md`。
- relevant_evolution: 当前 `master` 以国内 `showHiddenAgentTools` 作为 OpenCraft 试用门禁。
- superseded_refs: 无。

## acceptance
- 国内站主 Bot 与其他 Bot 的 Chat 默认启用 OpenCraft，`show()` 不改变 Chat owner。
- 国内站不请求 AgentChat 启动 token；国际站继续走 AgentChat。
- 执行并记录前端类型检查、聚焦测试、完整测试、国内构建及现有 lint 门禁的结果。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `docs/engineering/domains/site-environment-routing.md`
- `docs/engineering/domains/agent-gateway-runtime.md`
- `opencraft/docs/platform-architecture.md`

## required_context
- `site-environment-routing` Domain Pack；前端服务入口；前端运行时邻接卡。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@master` | 双站边界 | 国内启用且国际保持原行为 |
| `frontend/AGENTS.md@master` | 服务门禁 | 确定 lint/type/test/build |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@master` | 邻接测试与发布路径 | 检查相邻测试及制品配置 |
| `opencraft/docs/platform-architecture.md@master` | 内嵌工作台所有权契约 | 更新默认启用语义 |
| `docs/context/tasks/TASK-TEMPLATE.md@master` | Task Pack 格式 | 记录任务状态 |
| `docs/context/tasks/CHECKPOINT-TEMPLATE.md@master` | 交接格式 | 交接前保存状态 |

## evidence
- `origin/master@ca0908ec1`；已定位 `openCraftChatEnabled = !isGlobal && showHiddenAgentTools`。
- `pnpm check` 与 `pnpm typecheck` 通过：166 current / 171 baseline / 0 new / 5 resolved。
- OpenCraft 内嵌组件 14 项、国内默认 Chat 入口 1 项、发布矩阵与制品 40 项通过；国内构建通过。
- 侧栏测试另有 1 条布局断言失败；其期望字面量在未修改的 `origin/master` 页面已不存在。
- `pnpm lint` 无对应 script；完整 `pnpm test` 在多处无关失败及 worker 终止超时后停止，日志 `/tmp/cn-opencraft-default-frontend-test.log`。
- 最终文档校验通过（0 error、0 broken link、0 warning）；变更影响检查通过，`git diff --cached --check` 通过。
- MR !4907 的 CR 跟进：修复侧栏既有红测，并以页面渲染断言覆盖国内 OpenCraft / 国际 AgentChat；相关前端测试 53 项通过。

## risks
- 国内生产内嵌制品不可用时，OpenCraft 显示加载失败和重试；通过现有同源制品门禁及聚焦测试核验。
- 回滚：恢复国内 OpenCraft 的 `showHiddenAgentTools` 条件与 launch-token 请求逻辑。
- 国内默认启用也包含非主 Bot Chat，以及默认收起的网页标签和会话文件只读预览面板；发布回归须覆盖这些入口。

## validation
- `pnpm lint`（当前无 script）、`pnpm check`、`pnpm typecheck`、`pnpm test`、`NEXT_PUBLIC_OPENCRAFT_EMBED_SCRIPT_URL=/__opencraft/embedded-workbench.js pnpm build:cn`（frontend）。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`

## decisions
- 使用既有区域布尔值启用国内 OpenCraft，保留 `show()` 对其他隐藏工具的作用；owner：本轮用户需求。
- 本 MR 保持代码回滚：现有 CTL 开关读取进程环境变量，关闭仍需滚动服务；前端运行时配置在页面加载后异步获取，直接套用会产生 Chat owner 切换窗口。独立设计运行时熔断后再扩展跨服务配置。

## scan_scope
- `frontend/src/pages/marketing/`、`frontend/openspec/`、`frontend/release-matrix.json`。

## scan_output
- 有界 `rg` 已定位页面门禁、相邻测试、内嵌组件和生产制品配置。

## handoff
- 初版已提交 MR !4907；CR 跟进改动待更新 MR，线上尚未发布或验证。
