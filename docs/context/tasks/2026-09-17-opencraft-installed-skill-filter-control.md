## goal
让 OpenCraft Skills 已安装列表的分类与来源筛选复用共享 Select 的视觉和空间 contract，不再出现脱离触发器尺寸、覆盖相邻控件的浮层。

## non_goals
- 不改变已安装技能搜索、筛选语义、分类/来源数据或卸载行为。
- 不新增另一套 Select primitive，不修改全局 Select 默认几何。
- 不修改生产、GitOps 或远端 Hermes。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户截图与要求，2026-09-17：已安装技能筛选下拉是野生空间/控件，需要整改。

## interface_refs / data_structure_refs
- `frontend/src/components/ui/select.tsx`：共享 Radix Select 与主题 surface owner。
- `SkillsDemoPanel`：已安装分类、来源筛选状态 owner。
- `--radix-select-trigger-width`：浮层跟随触发器的几何 contract。

## history_context
- `current_design_refs`：`frontend/DESIGN.md`、`docs/context/tasks/2026-09-17-opencraft-skills-header-toolbar.md`。
- `relevant_evolution`：Header 已完成共享控件收敛；正文筛选仍保留临时硬编码 surface，并继承了大于触发器的全局最小浮层宽度。
- `superseded_refs`：无。

## acceptance
- 分类与来源筛选仍使用共享 Radix Select，键盘、焦点和选择行为不变。
- 浮层宽度等于触发器宽度，最大不越过视口，不覆盖相邻筛选控件。
- 实例只覆写 compact 尺寸，不再硬编码白色 surface、黑色边框、额外 padding 或独立 shadow。
- Frontend 聚焦组件测试、typecheck、OpenCraft 同步闭包和实际预览通过。

## affected_paths
- `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- `frontend/DESIGN.md`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/`

## required_context
- Pack `frontend-product-surface`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@2.1.0` | 路由 must_read | 前端真源与验证边界 |
| `frontend/AGENTS.md@current` | 最近服务入口 | 测试和生成规则 |
| `opencraft/AGENTS.md@current` | OpenCraft 边界 | 禁止手改同步目录 |
| `.agents/skills/baseline-ui/SKILL.md@current` | UI baseline | 复用 accessible primitive 和现有 token |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@current` | OpenCraft 维护方法 | 空间 contract 与实机证据 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 前端邻接 | 检查真源、测试和同步闭包 |

## evidence
- 截图与源码确认：触发器 `10rem`，浮层继承共享 `12rem` 最小宽度，并叠加业务局部 surface 样式。
- Red：组件回归读到 `min-w-[12rem] border-black/10 bg-white p-1 shadow-xl`，global/domestic 两组用例均失败。
- Green：`SkillsDemoPanel.test.tsx` 60/60 通过；分类与来源浮层都锁定 trigger width 并移除局部 surface 覆盖。
- Frontend typecheck、OpenCraft 同步闭包检查、LightVela Hermes plugin typecheck 和 platform boundaries 通过。
- `npm run build:electron` 通过。隔离 Electron profile `/tmp/opencraft-skills-toolbar-preview-current`、CDP 9361 实测：分类触发器 `160×36px`，菜单 `160×78px`，菜单右边界 `1544px`，来源触发器左边界 `1552px`，保留 `8px` 间距；来源菜单同样为 `160×78px`。
- 视觉证据：`/tmp/opencraft-installed-filter-control.png`。

## risks
- 长分类文案可能溢出；通过触发器宽度约束、视口最大宽度和共享 Item 布局处理。
- 上游同步可能覆盖 OpenCraft 生成副本；只改 `frontend/` 真源并运行既有同步脚本。

## validation
- Frontend Skills 聚焦测试与 typecheck。
- OpenCraft 生成闭包检查、相关 typecheck/边界检查。
- 实际打开分类与来源菜单，核对宽度、间距、焦点和相邻控件。

## decisions
- 不扩展全局 Select API；在业务页组合共享 primitive，并集中复用 compact 几何常量。

## scan_scope
- `frontend/src/pages/marketing/skills-demo/`
- `frontend/src/components/ui/select.tsx`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/`

## scan_output
- 有界源码、测试与当前截图检查，无独立扫描产物。

## handoff
- Complete：真源、生成闭包、组件回归、类型/边界门禁与隔离 Electron 实测均完成；未提交、未推送、未发布。
