## goal
让 OpenCraft Skills 路由 Header 复用统一的 Shell 设计 token 与现有控件基础，呈现与 Codex 原版一致的 segmented navigation 和安装目标选择器。

## non_goals
- 不改变 Skills 数据加载、安装、卸载或目标选择语义。
- 不修改生产、GitOps 或发布状态。
- 不新增另一套业务专用 Button、Tabs 或 Select 基础设施。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户会话要求：复用既有组件，避免重复建设，并按 Codex Header 视觉建模整改。

## interface_refs / data_structure_refs
- `PlatformViewRegions.Header`：路由内容投影到持久 AppShell Header。
- `SkillsDemoPanel` 的受控 `activeTab`：仍是 Skills tab 状态唯一 owner。
- `@opencraft/extension-react`：跨插件 React UI primitive 的共享入口。

## history_context
- `current_design_refs`：`opencraft/AGENTS.md`、`opencraft/docs/platform-architecture.md`。
- `relevant_evolution`：当前工作树已引入 route-scoped Header region，但直接投影上游 Radix Tabs，导致 Shell token 丢失。
- `superseded_refs`：无。

## acceptance
- Skills Header 使用共享 segmented primitive，不直接渲染上游页面 Tabs 外观。
- 安装目标 Select 使用 Shell 语义 token，在浅色和深色主题下无硬编码白/黑表面。
- 切换技能、技能包、已安装仍驱动原 `activeTab`，已安装计数保留。
- Web 上游未注入 Shell renderer 时保留现有 Tabs fallback。
- 通过相关 frontend 组件测试、OpenCraft 类型检查和聚焦测试，并完成当前 Electron 窗口视觉验证。

## affected_paths
- `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- `frontend/src/pages/marketing/agent-skills-panel.tsx`
- `opencraft/packages/extension-react/src/settings-controls.tsx`
- `opencraft/packages/extension-react/src/index.ts`
- `opencraft/packages/design-system/src/button.shared.ts`
- `opencraft/apps/workbench-web/src/components/app-shell-toolbar-select.tsx`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/plugins/lightvela-hermes/src/settings/hermes-skills-management-view.tsx`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/`

## required_context
- Pack `frontend-product-surface`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@2.1.0` | 路由 must_read | 前端验证和权威边界 |
| `frontend/AGENTS.md@current` | 最近服务入口 | 上游改动与门禁 |
| `opencraft/AGENTS.md@current` | OpenCraft 边界 | 生成目录与预览规则 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@current` | OpenCraft UI 维护方法 | 控件复用和可见验收 |
| `.agents/skills/baseline-ui/SKILL.md@current` | UI primitive 约束 | 防止重复 primitive 与样式硬编码 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 前端邻接卡 | 检查相邻测试与生成入口 |

## evidence
- `frontend`: Skills 聚焦 Vitest 2 files / 67 tests passed；typecheck 0 new diagnostics。
- `opencraft`: generated closure check passed；extension-react、lightvela-hermes、workbench-web typecheck passed；platform boundaries passed；`git diff --check` passed。
- `opencraft`: `npm run build:electron` passed，生成 `apps/workbench-web/dist-electron` 与 Electron host bundle。
- 隔离 Electron profile `/tmp/opencraft-skills-toolbar-preview-GcCQCO`、CDP 9361：实际窗口确认共享 segmented 呈现、技能/技能包切换、安装目标 Radix 菜单及 Header 拖拽区样式归属。
- 隔离 Electron profile `/tmp/opencraft-skills-toolbar-preview-current`、CDP 9361：替换后的 AppShell `ToolbarSelect` 触发器实测 `113×32px`、无边框、secondary surface；菜单实测 `200×62px`、5px surface padding、12px radius，单项 `189×28px`，标题与右侧选中勾存在。
- Skills 适配层已删除上游 Select imports/rendering，工作台样式已删除全部 `skills-install-target-*` 专用规则。
- Toolbar control 视觉 contract 已上收到 `design-system/tokens.shared.ts`、`tokens.web.scss` 与 `toolbar.web.scss`；业务样式只组合 mixin。最终 Electron 实测触发器 `107.6×32px`、10px radius、8px inline padding、13/18/500 排版、13px 平台映射图标和 10px chevron。
- `opencraft/AGENTS.md` 已固化“Feature 语义、Platform/Shell 呈现、Design System 视觉 contract”的分层原则，并要求测试阻止局部硬编码回流。
- `validate_documentation.py` passed；显式 changed-file `validate_change_impact.py` passed，并要求 `wisp/mono2-maintainers` review。
- 已知非本轮失败：`tests/lightvela-management-policy.test.ts` 当前有 7 个旧断言失败（旧 QR 命令、旧 modal 层级表达、缺失 option-group/segmented-control 生成文件等）；`workbench-window-chrome.test.ts` 在同次运行中通过。

## risks
- Header portal 脱离 `.lightvela-agent-console` 样式作用域；缓解：共享 primitive 由 AppShell 全局 token 驱动。
- 上游同步覆盖生成文件；缓解：只修改 `frontend/` 真源并执行 `sync:mono2-agent-console`。
- tab renderer 与 Tabs root 状态分叉；缓解：renderer 仅消费同一 `activeTab` 和同一切换函数。

## validation
- frontend Skills 聚焦测试与 typecheck。
- OpenCraft extension-react/workbench-web typecheck。
- OpenCraft Skills/management 聚焦测试。
- Electron 当前源码重建并实际检查 Header。

## decisions
- 扩展已有 Settings segmented 实现为共享 primitive；保留兼容 wrapper，不复制交互实现。
- Host/安装目标选择使用 AppShell 提供的 `ToolbarSelect` region primitive；扩展不再直接依赖正文 Select 或持有 Shell CSS。
- 上游 Skills 通过 render prop 接受宿主视觉，领域状态仍留在上游面板。
- 现有 Radix Select 保留交互，只增加 Shell token 化 presentation class。

## scan_scope
- `frontend/src/pages/marketing/skills-demo/`
- `opencraft/packages/extension-react/`
- `opencraft/apps/workbench-web/src/`
- `opencraft/plugins/lightvela-hermes/src/settings/`

## scan_output
- 使用有界 `rg` 与当前源码读取，无独立扫描产物。

## handoff
- 实现与本地实机验收完成；未提交、未推送、未发布。
