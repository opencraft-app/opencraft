## goal
概览页「最新动态」卡片只显示年月，并展示用户选定的三条 9 月 Changelog 动态。

## non_goals
- 不改变顶部权益有效期、独立 Changelog 页面的可见内容与顺序或轮播行为；不接入新的动态 API。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户截图红框标出动态卡片的日期，并要求「不用展示具体几号了，有年份和月份就好了」。
- 用户后续要求参考 LightVela Changelog 页面，同步最新三条动态。
- 用户再次指定用「支持套餐升配」替换概览中的「Agent 实例存储空间」。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-overview-panel.tsx` 的 `ChangelogEntry` 和 `LatestNewsSection`；Changelog 页面仅按月分组，因此概览条目存年月，依当前 locale 使用 `Intl.DateTimeFormat`。
- `frontend/src/pages/marketing/changelog-page.tsx` 的 `changelogGroups[0].entries` 是标题、说明、顺序和配图的参照。
- `frontend/src/pages/marketing/changelog-upgrade-copy.ts` 为 Changelog 页与概览页共用订阅升配的各语言文案。

## history_context
- `current_design_refs`：当前概览与 Changelog 组件源码及相邻本地化测试。
- `relevant_evolution`：`origin/master` 已有国际站本地化概览页；国际站线上 Changelog 与源码的最新三条一致。国内站线上页面比当前源码旧，本次按当前源码更新。
- `superseded_refs`：无。

## acceptance
- 概览动态卡片按 locale 显示年、月，不显示日；至少核对 en-US、zh-CN、ja-JP。
- 轮播仅有三条：创建多个 Bot、通知/脚本任务、订阅升配；第三条使用 Changelog 相同文案且不展示配图。
- 国内站和国际站的已有 Changelog 页面保留原有内容与顺序。
- 顶部权益到期日仍按原逻辑展示。

## affected_paths
- `frontend/src/pages/marketing/agent-overview-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-overview-localization.test.tsx`
- `frontend/src/pages/marketing/__tests__/agent-overview-news-domestic.test.tsx`
- `frontend/src/pages/marketing/changelog-page.tsx`
- `frontend/src/pages/marketing/changelog-upgrade-copy.ts`

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
- 后续替换第 3 条后，概览与 Changelog 聚焦测试 54 项通过；`pnpm check` 为 171 条既有 TypeScript 诊断、0 新增；`pnpm build`、staged change-impact 和 diff 检查通过。原 MR 提交的 CI 为 failure/blocking，需在新提交推送后重新核对。

## risks
- locale 的年月顺序和月份字形各异；使用现有 `Intl.DateTimeFormat`，聚焦测试验证。动态截图需按站点和 locale 选择。
- 升配条目在 Changelog 中没有配图；概览卡片保留文字布局与轮播高度，并复用同一份 locale 文案。

## validation
- 聚焦概览本地化测试、`pnpm check`（含 i18n 与类型检查）、`pnpm build`、`git diff --check`。当前 `package.json` 没有 `lint` 脚本。

## decisions
- Changelog 当前仅按月分组，不为概览条目编造具体日；只格式化年月。Owner：本次用户需求。
- 概览前两条沿用当前 Changelog 顺序；第三条依用户指定改为订阅升配，保留原 Changelog 页的其他条目。Owner：本次用户需求。

## scan_scope
- `frontend/src/pages/marketing/agent-overview-panel.tsx`、`changelog-page.tsx` 及相邻概览/Changelog 测试。

## scan_output
- 精确搜索定位 `LatestNewsSection`、`changelogGroups` 和 `upgradeCopies`；订阅升配在 Changelog 页以 `visual: "none"` 展示。

## handoff
- 用户已明确授权提交 MR !4664，并继续要求替换其中第 3 条。按已有授权更新该 MR；不包含合并或发布。
