---
id: agent-sidebar-overview-spacing-2026-10-07
type: task
scope: 国内站 Agent 左导航总览间距与字号调整。
triggers: ["Agent sidebar", "overview spacing", "left navigation typography"]
owner: pablozhong
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-07-agent-sidebar-overview-spacing.md
status: active
reviewed_at: 2026-10-07
review_due: 2026-11-07
revision: 1.0.0
precedence: task
derived: false
---

## goal
收紧国内站 Agent 左导航顶部「总览」入口的上下留白，使其两侧留白等高，并与下方「通道」「技能」使用相同字号。

## non_goals
- 不改导航顺序、交互、移动端间距或登录逻辑。
- 不合并、发布或修改线上服务。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-07 截图标注侧栏「总览」上下两处留白，要求稍微缩小并等高；「总览」字号与下方导航一致。

## interface_refs / data_structure_refs
- `fleetOverviewEnabled` 分支在 `agent-settings-page.tsx` 中把「总览」放在 `.lv-agents-sidebar-profile`，下方导航放在 `.lv-agents-sidebar-middle`。

## history_context
- `current_design_refs`: `frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/src/styles.css`。
- `relevant_evolution`: 当前桌面导航中段字号为 13px，顶部总览继承通用导航项的 14px。
- `superseded_refs`: 无。

## acceptance
- 桌面端「总览」行上下空白同为 8px；字体为 13px，与「通道」「技能」一致。
- 未出现新中文文案；相关前端检查、测试与构建通过。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/src/styles.css`。

## required_context
- 路由器对该任务无 Pack 匹配；按规则执行有界搜索。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md` | 前端边界与验证 | 限定样式与门禁 |
| `frontend/openspec/plan.md` | 前端现行计划 | 核查已有约束 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 前端邻接 | 选择相邻测试 |
| `frontend/src/pages/marketing/__tests__/agent-settings-nav-spacing.test.ts` | 邻接测试 | 核查桌面与移动端分支 |

## evidence
- 首次精确检索 `agent-sidebar*` 未命中导航文案；扩大到 `agent-settings-page.tsx` 后定位顶部总览分支与中段导航。
- 顶部总览原先使用桌面侧栏 12px 顶距及独立 wrapper 的下方 margin/padding；下方导航项字号为 13px，顶部总览继承 14px。
- 聚焦 Vitest 2 文件 9/9 通过；`pnpm check` 通过（166 current / 171 baseline / 0 new）；`pnpm build` 通过；`git diff --check` 通过。
- 本地 5175 预览已重启，技能页和更新后的 CSS 返回 HTTP 200；浏览器仍显示登录门槛，不能目视确认登录态侧栏。
- MR !5059 的 CR 指出缺少直接覆盖总览留白和字号的断言；已补入 `agent-settings-nav-spacing.test.ts`。合入当前 master 后，技能页与侧栏聚焦测试 119/119、`pnpm check`、国内与国际站构建均通过。

## risks
- 顶部总览仅在特定开关下显示；用专用 class 限定桌面样式，避免影响其他侧栏状态。
- 本地未登录，最终视觉效果待用户登录后检查。

## validation
- 聚焦 Vitest、`pnpm check`、`pnpm build`、`git diff --check`，并检查本地预览。

## decisions
- 保持桌面端总览入口内部行高不变，仅用对称外层留白与相同字号对齐下方导航。

## scan_scope
- `frontend/src/pages/marketing/` 与 `frontend/src/styles.css` 中的侧栏导航。

## scan_output
- 命中 `fleetOverviewEnabled` 总览入口、桌面侧栏间距规则和相邻导航间距测试。

## handoff
- CR 修正已提交至 MR !5059，等待新一轮 CI；本地 5175 端口预览持续运行。未合并、未发布，登录后的侧栏视觉验收仍待完成。
