## goal
移动端对话抽屉的「最近会话」列表每行只显示一个会话。

## non_goals
- 不改变其他设置导航分组的移动端列数。
- 不改变会话数据、选中、重命名或删除行为。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-02 截图与要求：「每行只显示一个会话」。

## interface_refs / data_structure_refs
- `AgentSettingsPage` 的会话列表 `<ul>`；`chatSessions.map` 与现有会话操作保持不变。

## history_context
- current_design_refs: `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md` 的会话列表渲染结构。
- relevant_evolution: 移动端通用 `.lv-agents-nav-group-items` 设置双列，聊天会话复用该 class。
- superseded_refs: 无。

## acceptance
- 320px、390px 手机宽度下，最近会话列表为单列；设置分组仍为现有列数。
- 桌面会话列表布局不变；前端检查及构建通过。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/styles.css`

## required_context
- `frontend-product-surface`；前端服务 context。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md` | 路由 must_read | 双站和验证边界 |
| `frontend/AGENTS.md` | 最近服务规则 | UI 与构建检查 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 前端邻接 | 检查规格和相邻测试 |
| `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md` | 会话列表约束 | 保持列表及操作结构 |

## evidence
- 源码中最近会话 `<ul>` 使用通用 `.lv-agents-nav-group-items`；移动端规则将它设为双列。
- 本地国内站 `/agents/chat/` 的抽屉在 390px 视口计算为单列 287px、320px 视口计算为单列 239px；桌面 1280px 下列表保持纵向 flex 布局。

## risks
- 仅更改会话列表列数，不涉及数据操作；通过浏览器手机视口确认。

## validation
- 侧栏聚焦测试 36/36、`pnpm check`、`pnpm build:cn`、`pnpm build:global`、`git diff --check` 通过。
- 本地账号的 Bot 为暂停状态，浏览器只能展示「默认对话」兜底项；多条真实会话的页面视觉未复现。

## decisions
- 为会话列表增加专用 class，只在移动端覆盖其网格列数。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/src/styles.css`、相邻规格和测试。

## scan_output
- 精确搜索命中会话列表 JSX、移动端网格 CSS 与侧边栏测试。

## handoff
- 独立工作树内修复完成；用户随后授权提交 MR，合并与发布另行处理。
