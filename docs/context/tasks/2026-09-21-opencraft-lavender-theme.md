## goal

为 OpenCraft 新增一个参考 LightVela frontend 低饱和紫色语汇的完整 Lavender 核心主题。

## non_goals

- 不修改 `frontend/` 当前产品 UI。
- 不改变默认主题、Light/Dark/System 偏好或现有主题色板。
- 不改变字体、密度、圆角、布局或组件交互。
- 不提交、推送、打包或发布。

## requirement_ids / requirement_refs / requirement_excerpt

- `USER-2026-09-21-LAVENDER-THEME`：查看现有主题引擎、主题与 frontend UI，增加淡紫色主题。

## interface_refs / data_structure_refs

- `CodexThemeDefinition`：颜色、语义状态、表面与材质的唯一主题 contract。
- `AppearanceThemeRecord`：核心主题目录、选择、持久化与扩展 fallback。
- 不变量：主题只拥有颜色/材质；组件几何和排版继续由 Design System 拥有。

## history_context

- `current_design_refs`：`opencraft/docs/workbench-design-language.md`、`opencraft/design/invariants.md`。
- `relevant_evolution`：当前 Codex、Vela、Frost、ZenCode 已共享同一 semantic token 投影。
- `superseded_refs`：无。

## acceptance

- Appearance 目录出现 Lavender，可与 Light/Dark/System 正交选择并持久化。
- 浅色主题提供淡紫 window/sidebar/input 与白色内容层；深色主题保持相同层级关系。
- Shell、表单、Popover、导航与状态色由共享 token 自动投影，无 Lavender 专用 Feature CSS。
- 聚焦测试、Web/Design System typecheck、Electron build 与真实预览通过。

## affected_paths

- `opencraft/packages/design-system/src/theme-engine.ts`
- `opencraft/apps/workbench-web/src/appearance-theme.ts`
- `opencraft/tests/workbench-appearance-theme.test.ts`
- `opencraft/docs/workbench-design-language.md`
- `opencraft/design/invariants.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context

- `frontend-product-surface`
- 根与 OpenCraft `AGENTS.md`
- `opencraft-maintenance`、`baseline-ui`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@working-tree` | frontend 产品 UI 路由 | 确认只读参考边界 |
| `frontend/AGENTS.md@working-tree` | frontend UI 与 token 约束 | 选择当前权威入口 |
| `frontend/src/theme/preset.ts@working-tree` | LightVela 品牌色板 | 提取中性文字和蓝紫强调关系 |
| `frontend/src/styles.css@working-tree` | 当前淡紫 token | 提取 `#dcc6ff` / `#F2F0F7` 低饱和语汇 |
| `opencraft/packages/design-system/src/theme-engine.ts@working-tree` | OpenCraft 主题权威 | 注册完整 semantic palette |
| `opencraft/apps/workbench-web/src/appearance-theme.ts@working-tree` | 主题目录与持久化 | 注册核心主题 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@working-tree` | frontend 相邻验证卡 | 确认本轮不触及运行时/i18n/生成物 |

## evidence

- `npx tsx --test tests/workbench-appearance-theme.test.ts tests/theme-material-capabilities.test.ts`：10/10 通过。
- Design System、Workbench Web、Workbench Electron typecheck：通过。
- `npm run check:boundaries`、`npm run build:electron`：通过。
- 文档校验、变更影响校验与 `git diff --check`：通过；变更影响提示由 `wisp/mono2-maintainers` 复核。
- 隔离 Electron profile `/tmp/opencraft-lavender-preview-PSejEl`：Light 实测 `themeId=vela.core.lavender`，window/sidebar/panel/input 分别为 `#f8f6ff/#f1ecff/#ffffff/#f7f4ff`；Dark 分别为 `#17141f/#1d1828/#221d2e/#2a2338`。
- 浅色正文/窗口对比度 `15.38:1`、强调色/窗口 `4.53:1`；深色分别为 `15.75:1`、`7.67:1`。
- 浅色真实窗口截图：`/tmp/opencraft-lavender-preview/screenshot-1789991624574.png`。

## risks

- 淡紫色若直接用作正文或大面积强调会降低对比度；正文保持深中性色，紫色只用于表面层级与单一强调色。
- Electron 原生背景与 Renderer surface 必须一致；通过 appearance bridge 和真实窗口 computed style 验证。

## validation

- `npx tsx --test tests/workbench-appearance-theme.test.ts tests/theme-material-capabilities.test.ts`
- `npm run typecheck --workspace @opencraft/design-system`
- `npm run typecheck --workspace @opencraft/workbench-web`
- `npm run build:electron`
- 隔离 Electron 选择 Lavender 并核对 Theme ID 与关键 computed token。

## decisions

- 名称为 `Lavender`，核心 ID 为 `vela.core.lavender`。
- 使用不透明、低饱和的完整 surface hierarchy，不复用 Frost 半透明 material。
- frontend 仅作为品牌色语汇参考，不复制页面 CSS。

## scan_scope

- `frontend/src/theme/preset.ts`、`frontend/src/styles.css`
- OpenCraft theme engine、appearance registry、settings theme cards与聚焦测试。

## scan_output

- 有界源码阅读，无独立扫描文件。

## handoff

- 当前状态：实现、聚焦测试、跨包门禁、Electron 构建与浅深色真实窗口 token 验收完成；预览窗口保持打开并恢复为 Light Lavender。
- 阻塞项：未提交、未推送、未重新打包 DMG。
