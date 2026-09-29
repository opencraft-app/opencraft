## goal

将 OpenCraft Electron 主窗口最小宽度从遗留的 760px 收敛到 Codex 当前的 480px，并复用 Shell 共享几何。

## non_goals

- 不改变默认窗口大小、保存的 Sidebar/Panel 偏好或窗口最小高度。
- 不打包、签名、提交或发布。

## requirement_ids / requirement_refs / requirement_excerpt

- `USER-2026-09-22-NARROW-WINDOW`：OpenCraft 支持的最窄窗口明显宽于 Codex，要求整改。

## interface_refs / data_structure_refs

- `workbenchWindowMetrics`：原生窗口与 Renderer 的最小宽度权威。
- `resolveShellSpace`：宽度压力下的 presentation fallback，不改写用户偏好。

## history_context

- `current_design_refs`：`opencraft/docs/platform-architecture.md`、`opencraft/design/invariants.md`。
- `relevant_evolution`：`760` 自首次导入 Electron Main 即存在，没有设计文档或布局模型来源；Shell 已测试 320/480px。
- `superseded_refs`：Main 内硬编码 `minWidth: 760`。

## acceptance

- Electron 原生最小宽度为 480px，最小高度仍为 560px。
- Main 与 Shell 不复制两份最小宽度。
- 480px 时隐藏 navigation/context/right，并保留其用户意图。
- Electron 构建与真实窗口 480px 验收通过。

## affected_paths

- `opencraft/packages/workbench-runtime/src/window-metrics.ts`
- `opencraft/packages/workbench-runtime/src/shell-space.ts`
- `opencraft/packages/workbench-runtime/{package.json,src/index.ts}`
- `opencraft/apps/workbench-electron/src/main.ts`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/tests/workbench-{shell-space,window-chrome}.test.ts`
- `opencraft/docs/platform-architecture.md`
- `opencraft/design/invariants.md`

## required_context

- 根/OpenCraft Agent 入口；`desktop-apps`、`adapt` Skills。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md@working-tree` | Electron/真实预览要求 | 验收边界 |
| `opencraft/packages/workbench-runtime/src/shell-space.ts@working-tree` | 共享宽度降级模型 | 唯一几何权威 |
| `/Applications/ChatGPT.app/Contents/Resources/app.asar@26.915.31945` | 当前 Codex 原生窗口实现 | 确认 `480×600` 参考值 |

## evidence

- 当前 Codex `26.915.31945` 的 `getPrimaryMinimumSize()` 返回 `480×600`；OpenCraft 保持既有 560px 最小高度，仅对齐 480px 最小宽度。
- 隔离 Electron（CDP 9464）由 macOS 原生窗口系统成功设置为 `480×700`。
- Home：viewport/document/header 均为 480px，无横向溢出。
- Settings：内容区 `[14, 466]`、`scrollWidth = clientWidth = 452`，无横向溢出。
- Skills：Header `scrollWidth = clientWidth = 480`；标签区在窄态内滚动，安装目标选择器固定 44px 并隐藏文字标签，不再与 tabs 重叠。
- 真实预览截图：`/tmp/opencraft-narrow-final/skills-480.png`。
- 聚焦测试 22/22、三个 workspace typecheck、边界检查及 Electron 构建通过。

## risks

- Header 和 feature 内容可能在真实 480px Electron 与单元模型间存在差异；必须用真实窗口检查溢出和控件可达性。

## validation

- `npx tsx --test tests/workbench-shell-space.test.ts tests/workbench-window-chrome.test.ts`
- Workbench Runtime/Electron typecheck、`npm run build:electron`。
- 隔离 Electron 调整到 480px，检查 Header、Home/Composer、Settings、Skills 和右侧 Panel fallback。

## decisions

- 与当前 Codex 对齐宽度 480px；保持 OpenCraft 当前最小高度 560px。
- Settings 的 760px 继续作为内容最大宽度，不参与窗口约束。

## scan_scope

- Electron Main、Shell geometry、窗口 chrome、窄窗相关测试及当前 Codex 安装包。

## scan_output

- Context Router 未匹配；执行有界精确搜索。

## handoff

- 实施与本地真实 Electron 验收完成；未提交、未发布、未更新 `/Applications` 中的安装包。
