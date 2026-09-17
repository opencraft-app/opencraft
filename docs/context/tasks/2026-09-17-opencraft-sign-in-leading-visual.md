## goal
让 Shell 匿名登录入口使用与导航一致的登录 action 图标，同时保留已登录账户的头像 identity 语义。

## non_goals
- 不改变登录流程、菜单、账号状态或认证 provider。
- 不新增自绘 SVG 或图标依赖。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户指出匿名登录白色头像底违和，并要求从图标库选择。

## interface_refs / data_structure_refs
- `AccountLeadingVisual`：根据匿名 action / 已登录 identity 投影 leading visual。

## history_context
- `current_design_refs`：`opencraft/docs/workbench-design-language.md`。
- `relevant_evolution`：匿名入口此前复用 `AccountAvatar`，错误继承圆形头像表面。
- `superseded_refs`：无。

## acceptance
- 匿名状态渲染 Lucide `LogIn` 且没有 avatar wrapper。
- 已登录状态继续渲染头像、首字母或 User fallback。
- 固定、浮动和菜单入口消费同一 helper。

## affected_paths
- `opencraft/apps/workbench-web/src/components/shell-navigation/`
- `opencraft/tests/workbench-shell-account.test.ts`
- `opencraft/docs/workbench-design-language.md`

## required_context
- OpenCraft `AGENTS.md` 的 UI 分层和图标复用规则。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `navigation-content.tsx@working-tree` | 当前账户视觉 owner | 区分 action 与 identity |
| `.agents/skills/better-icons/SKILL.md@current` | 用户要求图标库 | 搜索同系列登录图标 |

## evidence
- Better Icons 搜索命中 `lucide:log-in`；项目已使用同一 Lucide 组件。
- Workbench Web typecheck、账户/Sidebar 聚焦测试 26/26、platform boundaries 和 Electron renderer build 通过。
- 隔离 Electron DOM 验证：可见匿名入口包含 `.lucide-log-in`，不包含 `.sidebar-account__avatar`，文案保持 `Sign in`。

## risks
- 已登录 fallback 被误改；独立渲染断言覆盖匿名与已登录分支。

## validation
- Workbench Web typecheck、账户聚焦测试、Electron 当前源码预览。

## decisions
- 匿名入口使用 action glyph，不使用 avatar surface。
- 已登录身份继续使用 `AccountAvatar`。

## scan_scope
- Shell navigation 账户入口和相关测试。

## scan_output
- 无独立扫描产物。

## handoff
- 实现与隔离 Electron 验证完成；未提交、推送或发布。
