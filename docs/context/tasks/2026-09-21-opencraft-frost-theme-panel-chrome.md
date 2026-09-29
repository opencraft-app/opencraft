## goal

删除右侧面板自动全宽状态中的重复 `Back to chat` 控件，并新增使用固定浅蓝半透明 Sidebar material 的 Frost 主题。

## non_goals

- 不改变 Conversation、Panel tab 或 Router 身份。
- 不改变 Codex/Vela/Paper 主题现有材质。
- 不把 Frost 的透明度动态绑定到其他主题，也不把 Frost 设为默认选中主题。
- 不发布或覆盖已安装应用。

## requirement_ids / requirement_refs / requirement_excerpt

- `USER-2026-09-21-FROST-SIDEBAR`：删除 Back to chat；增加一个截图所示浅蓝 Sidebar 主题，透明度比普通主题低 50%，落地为独立常数。

## interface_refs / data_structure_refs

- `CodexThemeDefinition.shellMaterial`：Theme 对窗口与 Sidebar material 的唯一声明。
- `AppearanceThemeRecord`：核心主题注册、选择和持久化。
- `ShellPresentationContext`：只投影实际 Shell 状态/动作，不承载重复的 Panel toolbar 返回按钮。

## history_context

- `current_design_refs`：`opencraft/docs/workbench-design-language.md`、`opencraft/design/invariants.md`。
- `relevant_evolution`：右侧面板已有全局 toggle 与宽度 toggle；`Back to chat` 是 auto-full-width 的额外特例。
- `superseded_refs`：`restoreRightPanel` 仅供旧文字按钮消费，本轮删除。

## acceptance

- 自动全宽右侧面板不显示 `Back to chat`，仍可用全局 Panel toggle 关闭。
- 用户主动最大化时仍显示标准 Restore panel 图标。
- Appearance 中出现 Frost；Light/Dark/System 与主题 ID 保持正交。
- Frost 浅色 Sidebar material 为固定冷蓝 `35%` alpha，不引用 Codex 的 70% 表达式。
- 主题切换、持久化、扩展主题 fallback 和预览卡片通过聚焦测试。

## affected_paths

- `opencraft/apps/workbench-web/src/components/{right-panel,shell-presentation,app-shell}.tsx`
- `opencraft/apps/workbench-web/src/appearance-theme.ts`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/packages/design-system/src/theme-engine.ts`
- `opencraft/tests/{workbench-appearance-theme,workbench-timeline-host}.test.ts`
- `opencraft/docs/workbench-design-language.md`
- `opencraft/design/invariants.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context

- 根及 OpenCraft `AGENTS.md`
- `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`
- `normalize` 与 `baseline-ui` Skill

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | Shell/主题 owner 与实机验收 | 限制实现层级 |
| `opencraft/packages/design-system/src/theme-engine.ts@working-tree` | Theme semantic 与 shellMaterial 真源 | 注册固定材质 |
| `opencraft/apps/workbench-web/src/appearance-theme.ts@working-tree` | 核心/扩展主题目录 | 增加 Frost |
| `ref/codex/shared/toggle-maximize-side-panel-button-01708.ts@reference` | Codex 面板宽度控件 | 对照 icon-only Restore/Expand 行为 |

## evidence

- `npx tsx --test tests/theme-material-capabilities.test.ts tests/workbench-appearance-theme.test.ts tests/workbench-timeline-host.test.ts tests/workbench-panels.test.ts`：85/85 通过，包含并行新增的公共 Theme material capability 契约。
- `npm run typecheck --workspace @opencraft/workbench-web`：通过。
- `npm run build:electron`：Renderer、Main、Preload 与 Daemon 构建通过。
- 隔离 Electron profile：Frost 实际 `themeId=vela.core.frost`；根 token 为 `rgb(226 244 250 / 35%)`，Sidecar computed background 为 `rgba(226, 244, 250, 0.35)`。
- 当前 Renderer DOM：`Back to chat` 文本不存在，`.right-panel-back-to-chat` 不存在，Right Panel toolbar 保持挂载。

## risks

- 自动全宽与用户主动全宽必须区分；否则 Restore width 按钮可能在无空间时无效。
- 半透明材质依赖 Electron vibrancy/浏览器 backdrop；固定 alpha 仍需浅深模式和真实 Electron 验收。

## validation

- `npx tsx --test tests/workbench-appearance-theme.test.ts tests/workbench-timeline-host.test.ts tests/workbench-panels.test.ts`
- `npm run typecheck --workspace @opencraft/workbench-web`
- `npm run build:electron`
- 隔离 Electron：选择 Frost、检查 Sidebar computed token、自动全宽面板工具栏。

## decisions

- Frost 是可选核心主题，不改变产品默认主题。
- 固定 alpha 为 `35%`；不通过 `calc()`、`color-mix()` 或其他主题 token 推导。
- auto-full-width 不显示内部宽度动作；显隐继续归全局 Panel toggle。

## scan_scope

- `appearance-theme.ts`、`theme-engine.ts`、`right-panel.tsx`、`app-shell.tsx`
- `ref/codex/shared/toggle-maximize-side-panel-button-01708.ts`

## scan_output

- 有界源码阅读，无独立扫描文件。

## handoff

- 当前状态：实现、聚焦测试、构建与隔离 Electron token/DOM 验收完成；预览窗口保持运行。
- 阻塞项：未提交、未推送、未重新打包 DMG。
