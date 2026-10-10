## goal
缩小桌面 Agent 侧栏 Overview 入口与 Bot 选择框之间的空白。

## non_goals
- 不调整移动端抽屉、Bot 卡片尺寸、导航文字或其他区块间距。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-06 国际站 `/agents/chat/` 截图蓝框：“空白区域，间距稍微大了一些，调小点”。
- 沿用现有 MR !5036。

## interface_refs / data_structure_refs
- `fleetOverviewEnabled` 条件下的 Overview 入口位于 `.lv-agents-sidebar-profile` 中，紧邻 `.lv-agent-profile-row`。
- 只调整 Overview 外层桌面响应式间距类，保留移动端 `mb-2 pb-2`。

## history_context
- current_design_refs: `frontend/src/components/site/sidebar-user-menu.README.md`、`frontend/DESIGN.md`。
- relevant_evolution: 该桌面间距由 `10ceff9cac` 在 2026-10-04 引入；当前用户截图要求再缩小一点。
- superseded_refs: 无。

## acceptance
- 桌面 Overview 下方间距从 12px 降至 6px；移动端保持原样。
- 导航布局聚焦测试、前端检查和双站构建通过。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`

## required_context
- 路由查询 `frontend Agent sidebar overview Bot selector vertical spacing global desktop` 未命中 Pack；随后在 Agent 页面和样式中进行有界精确搜索。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md`（用户提供） | 仓库规则 | 确定 Task Pack 和验证边界 |
| `frontend/AGENTS.md`（本会话已读） | 前端门禁 | 确定检查、测试、构建和同步检查 |
| `frontend/src/pages/marketing/agent-settings-page.tsx` | 当前实现 | 定位 Overview 与 Bot 的相邻 DOM 和响应式间距 |
| `frontend/src/styles.css` | 侧栏布局 | 排除 Bot 行和移动端样式作为空白主因 |
| `frontend/src/pages/marketing/__tests__/agent-settings-nav-spacing.test.ts` | 相邻测试 | 确认既有桌面间距约束 |
| `frontend/src/components/site/agent-sidebar.tsx` | 容器实现 | 确认侧栏只管理滚动边缘 |

## evidence
- 源码：Overview 外层原为 `lg:mb-1.5 lg:pb-1.5`，桌面额外空间合计 12px；改为 `lg:mb-1 lg:pb-0.5`，合计 6px。
- `git blame` 显示间距类由 `10ceff9cac` 引入。
- 导航聚焦测试 45/45；`pnpm check` 新增 TypeScript 诊断 0。
- OpenCraft 的 130 个 Agent Console 文件同步检查通过；文档验证断链 0、未分类文档 0。
- `pnpm build:cn` 与 `pnpm build:global` 均通过；构建生成的 `next-env.d.ts` 变动已清理。

## risks
- 仅 `fleetOverviewEnabled` 的桌面 Overview 布局受影响；回滚为原间距类即可恢复。

## validation
- 已完成：聚焦测试、`pnpm check`、国内/国际构建、OpenCraft 同步检查与文档验证。
- 待完成：staged change-impact 检查与远端 MR 核验。

## decisions
- 调整现有 Tailwind 桌面间距类，不增加覆盖规则或改变 Bot 组件尺寸。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/src/styles.css` 与相邻导航测试。

## scan_output
- 精确搜索定位 Overview 外层响应式类和相邻 Bot 行；无独立扫描文件。

## handoff
- 本地验证完成，下一步更新 MR !5036；不合并或发布。

## checkpoint
### stage
- 本地验证完成，进入提交与远端核验。
### verified
- 桌面 Overview 下方间距从 12px 减至 6px；移动端间距类不变。
- 聚焦测试 45/45、前端检查和国内/国际构建通过。
### unverified
- 本次提交后的远端分支 SHA、MR 可合并状态和 CI 快照。
### discard
- 构建生成的 `next-env.d.ts` 临时改动。
### restore
- 工作树：`codex/mobile-account-menu`；目标 MR：!5036；仅提交页面间距类与 Task Pack。
### next_action
- staged 变更影响检查后提交、普通推送并核验远端 MR。
