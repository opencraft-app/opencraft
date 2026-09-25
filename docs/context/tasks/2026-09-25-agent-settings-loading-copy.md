## goal
把 Agent 设置页分区懒加载占位文案改为通用的 `Loading...`。

## non_goals
- 不改变加载、刷新、错误状态或 Achievements 数据请求。
- 不合并、发布或修改运行时环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 本轮用户请求（2026-09-25）：页面加载时把 `Loading page` 改为 `Loading...`；中文同样使用通用加载文案。外部需求 ID：unknown。

## interface_refs / data_structure_refs
- `AgentSettingsPage` 的 `sectionFallback` 与现有 `t("加载中...")` 翻译键；无 API 或数据结构变更。

## history_context
- `current_design_refs`：`docs/engineering/domains/site-environment-routing.md`、`frontend/src/i18n/index.ts`。
- `relevant_evolution`：原占位使用 `t("正在加载页面…")`；通用加载翻译键已存在。
- `superseded_refs`：无。

## acceptance
- 分区懒加载占位显示中文“加载中...”、英文 `Loading...`。
- diff 只包含目标文案及仓库要求的任务、设计记录；前端门禁通过。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `docs/engineering/domains/site-environment-routing.md`
- `docs/context/tasks/2026-09-25-agent-settings-loading-copy.md`

## required_context
- `frontend-product-surface`、`service-frontend`、`site-environment-routing`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@3a7d9da37` | 前端规则与门禁 | 确认 `pnpm check`、聚焦测试 |
| `docs/context/project/services/frontend.md@3a7d9da37` | 服务上下文 | 确认 i18n 与双站边界 |
| `docs/context/domains/site-environment-routing.md@3a7d9da37` | Domain Pack | 保留本地化行为 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@3a7d9da37` | 相邻生成物与测试 | 核对既有翻译键和测试 |
| `docs/engineering/domains/site-environment-routing.md@3a7d9da37` | 正式设计 | 同步加载文案决策 |
| `docs/context/tasks/TASK-TEMPLATE.md@3a7d9da37` | Task Pack 模板 | 记录目标与证据 |

## evidence
- 最新 `origin/master` 的占位原文为 `t("正在加载页面…")`，英文资源已有 `Loading...`。
- `pnpm check` 通过；TypeScript baseline 无新增诊断。
- 聚焦 Vitest 36 个用例通过；`git diff --check` 通过。
- `pnpm build` 通过；文档检查和 staged change-impact 检查通过。
- 全量 `pnpm test` 在模型配置、自动任务、文档等不相邻套件出现多处失败，之后停滞并中止；未证明这些失败在基线重现。

## risks
- 多个 Agent 分区共用该占位，文案会同时变化；复用现有 i18n 键保持各语种已有译文。

## validation
- `pnpm check`、聚焦 Agent 设置侧栏测试、`git diff --check`、staged change-impact 检查。

## decisions
- 复用现有翻译键，不新增生成的 locale 条目。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/src/i18n/`、相邻测试与 OpenSpec。

## scan_output
- 无独立扫描产物。

## handoff
- 本地实现与聚焦门禁完成；全量测试未通过，具体边界见 evidence。以远端 MR 实时状态为准。
