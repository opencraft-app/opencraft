## goal
加深截图中 Agent 左侧导航、对话入口和账号弹出菜单的操作文字颜色，使其与说明文案区分。

## non_goals
- 不改文字大小、间距、布局、选中态或页面正文。
- 不改顶部头像菜单及账号、套餐功能逻辑。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-06 三张截图蓝框：左侧菜单主要操作按钮的文字颜色“稍微有点浅”，要求加深。
- 延续现有 Agent 菜单 MR !5036。

## interface_refs / data_structure_refs
- `frontend/src/styles.css` 的 `.lv-agents-sidebar .lv-agents-nav-item`、`.lv-agents-chat-toggle`、`.lv-sidebar-user-menu-item`。
- 保留 `.is-active` 的深色和分组标题、套餐说明的次级文字色。

## history_context
- current_design_refs: `frontend/DESIGN.md`、`frontend/src/components/site/sidebar-user-menu.README.md`。
- relevant_evolution: MR !5036 已包含移动端账号入口及菜单关闭交互；本次只改视觉层级。
- superseded_refs: 无。

## acceptance
- 国内站日常与探索导航、对话标题、会话项、账号菜单项使用一致的较深普通态颜色。
- 分组标题、描述文案及已选中态维持现有层级；国内与国际构建通过。

## affected_paths
- `frontend/src/styles.css`

## required_context
- 路由 Pack：`frontend-product-surface`；必读：`docs/context/project/services/frontend.md`；最近服务级：`frontend/AGENTS.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md`（用户提供） | 仓库边界 | 确定 Task Pack 和交接门禁 |
| `docs/context/project/services/frontend.md` | 路由必读 | 明确前端双站与视觉验证要求 |
| `frontend/AGENTS.md` | 前端服务规则 | 确定 check、build、OpenCraft 同步检查 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 前端邻接 | 检查相邻测试及生成入口 |
| `frontend/src/styles.css` | 当前样式 | 定位普通、选中和次级文字色 |
| `frontend/src/pages/marketing/agent-settings-page.tsx` | 导航标记 | 确认三个截图的导航项共用类 |
| `frontend/src/components/site/sidebar-user-menu.tsx` | 菜单标记 | 确认账号弹层使用独立操作项类 |
| `frontend/src/pages/marketing/__tests__/agent-settings-nav-spacing.test.ts` | 相邻测试 | 确认现有导航布局断言不受影响 |

## evidence
- 有界搜索确认：普通导航文字为次级色（70%），对话标题为 60%，账号操作项为次级色；选中态约为 `#171717`。
- `frontend/openspec/` 有关联的历史导航计划，但没有本次颜色约束；以当前样式和截图要求为准。
- 导航与账号菜单聚焦测试 28/28；`pnpm check` 新增 TypeScript 诊断 0。
- OpenCraft 的 130 个 Agent Console 文件同步检查通过；文档验证断链 0、未分类文档 0。
- `pnpm build:cn` 与 `pnpm build:global` 均通过，生成的 `next-env.d.ts` 变动已清理。

## risks
- 导航图标从父项继承文字色，会随操作项一起略微加深；保持现有继承关系。
- 改动限定在 Agent 侧栏与账号浮层，不改变全站次级色 token。

## validation
- 已完成：导航聚焦测试、`pnpm check`、国内/国际构建、OpenCraft 同步检查和文档验证。
- 待完成：staged change-impact 检查与远端 MR 核验。

## decisions
- 将普通操作项设为 82% 黑色，介于当前普通态与已选中态之间；不新增全局 token。

## scan_scope
- `frontend/src/styles.css`、Agent 侧栏页面及相邻测试；首次查找 `agent-sidebar-session-list.tsx` 未命中，改查实际页面标记。

## scan_output
- 有界搜索结果见本 Task Pack 的 `evidence`，未生成独立扫描文件。

## handoff
- 本地验证完成，下一步更新原 MR !5036；不合并或发布。

## checkpoint
### stage
- 本地验证完成，进入提交与远端核验。
### verified
- 导航及账号菜单文字色仅在三个目标选择器内调整；聚焦测试、前端检查和双站构建通过。
### unverified
- 本次提交后的远端分支 SHA、MR 可合并状态及 CI 快照。
### discard
- 构建时生成的 `next-env.d.ts` 改动。
### restore
- 工作树：`codex/mobile-account-menu`；目标 MR：!5036；本次仅提交样式和 Task Pack。
### next_action
- staged 变更影响检查后提交、普通推送并核验 MR。
