## goal

在 OpenCraft 桌面侧栏收起时，于原生交通灯后的共享 titlebar rail 增加 Codex 同语义的 Write / Start new task 按钮，并复用 `navigateToHome`。

## non_goals

- 不创建远端 Thread，不改变 Draft / Conversation 生命周期。
- 不在侧栏展开时重复显示 Write；展开态继续使用 Sidebar 的 Start。
- 不修改原生交通灯、侧栏 toggle、History 或 Right Panel 的 owner。
- 不提交、推送、打包发行或覆盖用户安装。

## requirement_ids / requirement_refs / requirement_excerpt

- `USER-2026-09-21-WINDOW-WRITE`：在用户截图所示的 macOS 窗口 Chrome 中增加 Write 按钮。

## interface_refs / data_structure_refs

- `apps/workbench-web/src/components/app-shell-header.tsx`：唯一物理 titlebar action rail。
- `apps/workbench-web/src/window-chrome.ts`：安全区与首帧 action rail 几何。
- `AppShellNavigationControls.onHome`：复用 Home / 新草稿导航意图。

## history_context

- `current_design_refs`：`opencraft/AGENTS.md` 应用导航不变量、`opencraft/docs/workbench-design-language.md`、`opencraft/design/invariants.md`。
- `relevant_evolution`：Sidebar 的 Start 已统一为 `navigateToHome`；本轮只增加收起态的第二个物理入口。
- `superseded_refs`：无。

## acceptance

- Electron/macOS 侧栏收起时，Sidebar toggle 后显示 Write 按钮；展开时按钮消失。
- 点击 Write 调用既有 Home intent，不直接创建 Thread。
- 浮动 Sidebar 的 transient header 不重复 Write。
- Action rail 首帧最小宽度、真实测量宽度和安全区一致，不覆盖标题或原生交通灯。
- 图标按钮有 label/title/focus/hover，使用共享 chrome-button。

## affected_paths

- `opencraft/apps/workbench-web/src/components/app-shell-header.tsx`
- `opencraft/apps/workbench-web/src/components/app-shell.tsx`
- `opencraft/apps/workbench-web/src/chrome-actions/new-task-icon.tsx`
- `opencraft/apps/workbench-web/src/window-chrome.ts`
- `opencraft/tests/workbench-window-chrome.test.ts`
- `opencraft/docs/workbench-design-language.md`
- `opencraft/design/invariants.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context

- 根 `AGENTS.md`
- `opencraft/AGENTS.md`
- `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`
- `.agents/skills/baseline-ui/SKILL.md`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md@working-tree` | Router/Home 与 Shell chrome 不变量 | Write 复用 `navigateToHome` |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | OpenCraft 平台 UI 维护边界 | 防止页面私建 titlebar action |
| `.agents/skills/baseline-ui/SKILL.md@working-tree` | 图标按钮可访问性与交互基线 | 复用共享按钮并补 label |
| `ref/codex/lazy/app-initial/use-temporary-chat-shortcut.js@reference` | Codex Electron 注册行为 | 确认仅在 Sidebar hidden 时显示 |
| `ref/codex/lazy/app-initial/noop-module-h-ec-6z502.js@reference` | Codex Write glyph | 对照 16×16 图标几何 |

## evidence

- `npx tsx --test tests/workbench-window-chrome.test.ts tests/workbench-sidebar-dock.test.ts`：32/32 通过。
- `npm run typecheck --workspace @opencraft/workbench-web`：通过。
- `npm run build:electron`：Renderer、Main、Preload 与 Daemon 构建通过。
- 隔离 Electron `/tmp/opencraft-write-profile-AzkLCj`：Sidebar 展开时无 Write；收起后 AX 中出现 `Start new task`，位置紧随 Sidebar toggle；从 Skills 点击 Write 返回 Home 并聚焦 Composer。

## risks

- 动态增加 action 会改变左侧 rail 宽度；必须同时更新首帧最小宽度与真实测量。
- Header 有 persistent/transient 两个宿主；只允许 persistent 渲染 Write，避免浮动侧栏重复入口。

## validation

- `npx tsx --test tests/workbench-window-chrome.test.ts tests/workbench-sidebar-dock.test.ts`
- `npm run typecheck --workspace @opencraft/workbench-web`
- `npm run build:electron`
- 隔离 Electron 收起/展开与点击预览。

## decisions

- 按 Codex 语义实现“收起态 Write”，不是给 policy 静态增加一个永远显示的按钮。
- 使用共享 Header rail 与 `chrome-button`，不增加页面级绝对定位 CSS。

## scan_scope

- `ref/codex/lazy/app-initial/use-temporary-chat-shortcut.js`
- `ref/codex/lazy/app-initial/noop-module-h-ec-6z502.js`
- `opencraft/apps/workbench-web/src/{components/app-shell-header.tsx,components/app-shell.tsx,window-chrome.ts}`

## scan_output

- 有界源码阅读；未生成独立扫描文件。

## handoff

- 当前状态：实现、模型验证、构建与隔离 Electron 实机交互均完成；预览窗口保持运行。
- 阻塞项：未提交、未推送、未打包发行。
