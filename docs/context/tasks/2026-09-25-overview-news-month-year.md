## goal
概览页「最新动态」卡片只显示年月，并与 LightVela Changelog 页的最新三条保持一致。

## non_goals
- 不修改顶部权益有效期、独立 Changelog 页面或轮播行为；不接入新的动态 API。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户截图红框标出动态卡片的日期，并要求「不用展示具体几号了，有年份和月份就好了」。
- 用户后续要求参考 LightVela Changelog 页面，同步最新三条动态。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-overview-panel.tsx` 的 `ChangelogEntry` 和 `LatestNewsSection`；Changelog 页面仅按月分组，因此概览条目存年月，依当前 locale 使用 `Intl.DateTimeFormat`。
- `frontend/src/pages/marketing/changelog-page.tsx` 的 `changelogGroups[0].entries` 是标题、说明、顺序和配图的参照。

## history_context
- `current_design_refs`：当前概览与 Changelog 组件源码及相邻本地化测试。
- `relevant_evolution`：`origin/master` 已有国际站本地化概览页；国际站线上 Changelog 与源码的最新三条一致。国内站线上页面比当前源码旧，本次按当前源码更新。
- `superseded_refs`：无。

## acceptance
- 概览动态卡片按 locale 显示年、月，不显示日；至少核对 en-US、zh-CN、ja-JP。
- 轮播仅有最新三条：创建多个 Bot、通知/脚本任务、Agent 实例存储空间；标题、说明与图片匹配 Changelog 页，核对国内站和国际站素材。
- 顶部权益到期日仍按原逻辑展示。

## affected_paths
- `frontend/src/pages/marketing/agent-overview-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-overview-localization.test.tsx`
- `frontend/src/pages/marketing/__tests__/agent-overview-news-domestic.test.tsx`

## required_context
- `frontend-product-surface`：`docs/context/project/services/frontend.md`；服务级 `frontend/AGENTS.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@791224baf` | 前端服务边界 | 确认双站本地化与验证要求 |
| `frontend/AGENTS.md@791224baf` | 服务级规则 | 确认最小有效门禁 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@791224baf` | i18n 与相邻测试 | 检查本地化测试和生成物边界 |
| `frontend/src/pages/marketing/changelog-page.tsx@791224baf` | 当前 Changelog 实现 | 确定最新三条的顺序、文案和配图 |
| `docs/context/tasks/TASK-TEMPLATE.md@791224baf` | Task Pack 格式 | 记录任务状态 |
| `docs/context/tasks/CHECKPOINT-TEMPLATE.md@791224baf` | 交接格式 | 交接时更新检查点 |

## evidence
- `origin/master` 中 `LatestNewsSection` 用 `day: "numeric"` 格式化动态日期；`HeroBanner` 的权益到期日由另一字段提供。
- 2026-09-25 核对 `https://lightvela.ai/changelog` 搜索索引与仓库 `changelogGroups[0].entries`：前三条顺序一致。`https://lightvela.com/changelog/` 的线上内容较源码旧。
- 最终源码的概览本地化及国内站组件测试 31 项通过；`pnpm check` 与 `pnpm typecheck` 为 171 条既有 TypeScript 诊断、0 新增；`pnpm build`、`git diff --check` 通过。构建生成的字体子集差异已还原。

## risks
- locale 的年月顺序和月份字形各异；使用现有 `Intl.DateTimeFormat`，聚焦测试验证。动态截图需按站点和 locale 选择。

## validation
- 聚焦概览本地化测试、`pnpm check`（含 i18n 与类型检查）、`pnpm build`、`git diff --check`。当前 `package.json` 没有 `lint` 脚本。

## decisions
- Changelog 当前仅按月分组，不为概览条目编造具体日；只格式化年月。Owner：本次用户需求。
- 概览前三条按当前 Changelog 源码与已核对的国际站页面同步；国内站线上页面较旧是交付状态差异。Owner：本次用户需求。

## scan_scope
- `frontend/src/pages/marketing/agent-overview-panel.tsx`、`changelog-page.tsx` 及相邻概览/Changelog 测试。

## scan_output
- 精确搜索定位 `LatestNewsSection` 与 `changelogGroups`；2026 年 9 月分组当前首三条相同，但国内外素材按站点/locale 分流。

## handoff
- 独立 worktree 的源码与聚焦测试改动已完成并通过本地验证。用户现已明确要求提交 MR，授权本次 commit、push 与 MR 创建；不包含合并或发布。
