## goal
将「支持套餐升配」移到 2026 年 9 月产品动态首位，并在 Changelog 与概览页展示真实升配页面截图。

## non_goals
- 不改套餐、支付、升配流程或价格；不发布线上版本。
- 不扩充概览页现有三条动态的数量。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户本轮要求：「把套餐升配这条，挪到9月的第一条吧，然后增加一个截图，用升配页面的截图」。
- 前序任务见 `docs/context/tasks/2026-09-25-overview-news-month-year.md`；现有 MR !4664 已合并至 `origin/master@f3d40ccf3`。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/changelog-page.tsx` 的 `changelogGroups`、`VisualCard` 决定月内顺序和图片。
- `frontend/src/pages/marketing/agent-overview-panel.tsx` 的 `getChangelogEntries` 决定概览页三条及轮播首项。
- `frontend/src/pages/marketing/changelog-upgrade-copy.ts` 继续提供双站各语言标题与说明。

## history_context
- `current_design_refs`：`frontend/openspec/specs/marketing.md`、当前两个页面组件与相邻测试。
- `relevant_evolution`：前序 MR 将升配设为概览第三条，且两处均无升配配图；本轮依用户要求调整。
- `superseded_refs`：前序 Task Pack 中「第三条无配图」的验收条件已被本轮要求替代。

## acceptance
- 国内、国际站 9 月 Changelog 第一条均为升配，且使用各自真实升配页截图。
- 概览页仍只展示三条，升配位于第一条，展示同站截图；年月格式维持不变。
- 截图不包含账号信息或 URL 查询参数；相邻组件测试、`pnpm check`、双站构建及变更检查通过。

## affected_paths
- `frontend/src/pages/marketing/changelog-page.tsx`
- `frontend/src/pages/marketing/agent-overview-panel.tsx`
- `frontend/src/pages/marketing/__tests__/`
- `frontend/public/assets/changelog/lightvela-plan-upgrade-{cn,global-en}.png`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/UPSTREAM.json`（如同步脚本报告漂移）

## required_context
- `frontend-product-surface`、`service-frontend`、`site-environment-routing`、`subscription-entitlements`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@f3d40ccf3` | 前端门禁与视觉规则 | 确定测试和构建要求 |
| `docs/context/project/services/frontend.md@f3d40ccf3` | 双站前端边界 | 分站核对图片 |
| `docs/context/domains/site-environment-routing.md@f3d40ccf3` | 站点边界 | 防止国内图用于国际站 |
| `docs/context/domains/subscription-entitlements.md@f3d40ccf3` | 订阅边界 | 仅改展示，不触及支付逻辑 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@f3d40ccf3` | 前端邻接 | 检查 OpenSpec、i18n 与测试 |
| `frontend/openspec/specs/marketing.md@f3d40ccf3` | Changelog 和订阅路由 | 确认现有页面职责 |
| `frontend/src/i18n/index.ts@f3d40ccf3` | locale 装载 | 核对国际站语言范围 |
| `docs/context/tasks/TASK-TEMPLATE.md@f3d40ccf3` | Task Pack 格式 | 记录任务 |
| `docs/context/tasks/CHECKPOINT-TEMPLATE.md@f3d40ccf3` | 检查点格式 | 记录交接状态 |

## evidence
- 国内与国际站均从登录后的升配入口进入真实升配页，分别截取当前套餐与可升配套餐卡片；两张 PNG 均为 2200×1240，未显示账号信息或查询参数。
- 四个聚焦测试文件共 55 项通过；`pnpm check` 通过，TypeScript 诊断为 171 条基线、0 新增；`pnpm build:cn` 与 `pnpm build:global` 通过。
- `npm --prefix opencraft run check:mono2-agent-console` 通过，vendored closure 无漂移。
- 待补：远端 MR 与 CI 状态。

## risks
- 截图中出现实时套餐价格，未来价格变化时可能过时；图片可在本条动态中单独替换。
- 国际站非英语 locale 暂使用国际站英语截图，以保持站点和价格正确；后续可补各语言截图。

## validation
- 聚焦概览与 Changelog 测试、`pnpm check`、`pnpm build:cn`、`pnpm build:global`、OpenCraft closure 检查均已通过；staged change-impact 与 diff 检查待执行。

## decisions
- 概览首项同步置顶，因为它是 9 月 Changelog 的三条精选展示；保留原来的另两条。Owner：用户本轮要求。
- 分站使用实际页面截图；图片无账号信息和升配查询参数。Owner：用户本轮要求。

## scan_scope
- 两处页面组件、四个相邻组件测试、OpenSpec 营销页规格、i18n 入口。

## scan_output
- 精确搜索命中 `upgradeEntry`、`getChangelogEntries` 与相邻测试；无独立动态 API。

## handoff
- 待完成验证与新 MR；本轮不合并或发布。
