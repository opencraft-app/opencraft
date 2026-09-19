## goal
重构 OpenCraft xterm 几何所有权，使视觉 inset 与 FitAddon measurement host 分离，并在尺寸、字体和可见性变化后保持终端网格、DOM 与 PTY cols/rows 一致。

## non_goals
- 不通过普通文本换行或外层裁切掩盖 xterm 网格错误。
- 不改变 Terminal session 身份、历史、输入、重连或关闭语义。
- 不发布、不操作生产或用户真实会话。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户报告长连续终端文本进入容器右侧 inset，并要求综合 Codex/BB 模型增加不变量后重构。

## interface_refs / data_structure_refs
- `TerminalPanel`：终端 DOM 与 FitAddon owner。
- `AppServerTerminalSession.resize(cols, rows)`：PTY 网格发布边界。
- WSP-21：visual inset、measurement host、xterm grid 与 PTY size 的一致性。

## history_context
- `current_design_refs`：`opencraft/design/invariants.md`、`opencraft/docs/platform-architecture.md`。
- `relevant_evolution`：当前实现把 padding、xterm mount 和 ResizeObserver 放在同一元素；Codex/BB 将 padding 外壳与无 padding measurement host 分离。
- `superseded_refs`：无。

## acceptance
- FitAddon 与 ResizeObserver 只消费无 padding 的 xterm host content box。
- 长连续 ASCII 不进入视觉 inset；screen 右边界不超过 host。
- 缩窄、拉宽、隐藏后重显、字体加载后重新 fit。
- 相同 cols/rows 不重复发布 PTY resize。
- 聚焦测试、类型检查、边界检查、Electron 构建和真实窗口复现通过。

## affected_paths
- `opencraft/plugins/terminal/src/index.tsx`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/tests/workbench-terminal.test.ts`
- `opencraft/design/invariants.md`

## required_context
- 根与 OpenCraft `AGENTS.md`；OpenCraft maintenance verification。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/plugins/terminal/src/index.tsx@working-tree` | 当前 xterm owner | 定位 padding 与 measurement 混用 |
| `ref/codex/lazy/app-initial/xterm-output-panel-BGahLIKf.js@current-pin` | Codex 参考 | 提取外壳/host、字体和 zoom refit 模型 |
| `ref/bb/apps/app/src/components/thread/terminal/ThreadTerminalView.tsx@current-pin` | BB 参考 | 提取 contentRect、visible guard、font load 和 reactivation 行为 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@current` | 验收规则 | 选择几何、真实客户端和 Host 证据 |

## evidence
- Terminal 与 Workbench Web typecheck 通过；`workbench-terminal.test.ts` 7/7 通过，包含真实 PTY `stty size`、重连与新增网格 helper/DOM ownership 回归。
- `npm run check:boundaries` 与 `git diff --check` 通过；Electron renderer 构建通过。
- 隔离 Electron/CDP 实测：visual inset `699px`，左右 padding `10px`；无 padding host `679px`；xterm screen `662px`（扣除 scrollbar）且右边界未超过 host。
- 首次同步 fit 后不再停留默认 80 列；200 个连续 `l` 按 `92 + 92 + 16` 三行换行，三行与 screen 均位于 host content box 内。
- 隐藏并重显 task details 后保留同一输出，host/screen 恢复为 `679/662px` 且边界仍成立。

## risks
- 额外 DOM 层改变焦点或选择；xterm mount/focus 仍绑定内层 host，selection owner 保留外壳。
- font loading 回调可能晚到；以 disposed generation 阻止卸载后 fit。
- 重复 observer 可能产生 resize 风暴；rAF 合并且只发布变化后的网格。

## validation
- Terminal helper/contract 聚焦测试。
- Terminal、Workbench Web typecheck 与 platform boundaries。
- Electron renderer 构建与隔离 profile 真实长文本/resize 检查。

## decisions
- 修复 measurement ownership，不增加 `overflow-wrap`。
- visual inset 与 xterm host 使用独立 DOM 节点。
- fonts ready/loadingdone 与可见 contentRect 都能使旧 fit 失效。

## scan_scope
- OpenCraft terminal plugin、right panel CSS/tests。
- 固定版本 Codex/BB terminal 实现。

## scan_output
- 无独立扫描产物。

## handoff
- 模型、实现、聚焦验证与隔离 Electron 实测完成；未提交、推送或发布。
