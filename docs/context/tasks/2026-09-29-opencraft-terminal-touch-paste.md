## goal
让 OpenCraft Web 终端在手机触控场景可粘贴文字，同时保留桌面键盘粘贴和终端原有输入语义。

## non_goals
- 不替换 PTY、终端库或发布正在运行的服务。
- 不读取或记录用户剪贴板内容。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户本会话反馈：“终端不支持粘贴文字怎么解？”；多次要求继续。没有外部 PRD。

## interface_refs / data_structure_refs
- `plugins/terminal/src/index.tsx` 的 TerminalPanel、xterm `paste()`、现有 `onData` → `session.write`。
- `apps/workbench-web/src/styles/app.scss` 的 Terminal Panel 槽位与独立字符网格。
- 不变量：只有当前运行中的终端能接收粘贴；浏览器剪贴板失败必须有触控可用的原生粘贴入口；剪贴板内容不持久化。

## history_context
- `current_design_refs`: `opencraft/docs/platform-architecture.md` 的 Terminal character metrics 和 Conversation terminal semantics；`opencraft/design/invariants.md` 的 WSP-21/22。
- `relevant_evolution`: 当前 TerminalPanel 仅挂载 xterm 的隐藏 textarea，没有产品级触控粘贴入口。
- `superseded_refs`: 无。

## acceptance
- 点击“粘贴”在浏览器允许时经 xterm `paste()` 发送；不可读取时出现可长按粘贴的原生文字输入位，由用户确认发送。
- 空内容、非运行状态、切换终端后的迟到读取不会发送。
- 终端网格不因粘贴入口改变尺寸；聚焦测试、类型检查与样式构建通过。手机内置浏览器需后续实机确认系统菜单。

## affected_paths
- `opencraft/plugins/terminal/src/index.tsx`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/tests/workbench-terminal.test.ts`
- `opencraft/docs/platform-architecture.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- `agent-gateway-runtime`, `site-environment-routing`, `upstream-subtrees`, `service-opencraft`；其中仅 OpenCraft 与 Web 输入边界本次实际影响决策。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md`、`opencraft/AGENTS.md` | 根与服务规则 | 维护边界与验证要求 |
| `docs/context/domains/agent-gateway-runtime.md`、`docs/context/domains/site-environment-routing.md` | Context Router 必读 | 确认不触碰网关或双站发布 |
| `docs/context/project/upstream-subtrees.md`、`docs/context/project/services/opencraft.md` | Context Router 必读 | 确认 mono2 唯一写入源 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`、`references/verification.md` | 维护方法 | 选择聚焦测试与真实平台验收 |
| `opencraft/docs/platform-architecture.md`、`opencraft/design/invariants.md` | 终端正式设计 | 保留 xterm 网格与 PTY 所有权 |

## evidence
- 源码：当前 xterm 5.5.0 的 `Terminal.paste()` API 负责粘贴换行及 bracketed-paste；TerminalPanel 原本只有隐藏输入框和 `onData` 写入。
- Terminal plugin 与 Web workspace 的 TypeScript 类型检查通过。
- `workbench-terminal.test.ts` 9 项通过，包含粘贴走 xterm 和迟到结果隔离。
- Web Vite 构建到独立 `/tmp/opencraft-terminal-vite-check-20260929` 成功，未覆盖当前运行预览。
- 变更路径的 docs-impact 检查通过；规则提示仍需 `wisp/mono2-maintainers` 评审。

## risks
- iOS/企业微信内置浏览器可能拒绝异步剪贴板读取；使用原生输入位作为回退，实机仍需验证。
- 粘贴带换行文本可能被 shell 执行；沿用 xterm 既有粘贴语义，手动回退路径需显式确认。

## validation
- Terminal plugin 与 Web workspace 类型检查、终端聚焦测试、样式构建、diff 检查；触控实机仍待验收。

## decisions
- Clipboard API 只用于按钮触发的快捷路径；失败不显示内部权限术语，直接打开原生输入位。
- 输入仍通过 xterm `paste()`，不绕过终端的换行/bracketed-paste 处理，也不新增 PTY owner。

## scan_scope
- `opencraft/plugins/terminal/`、`opencraft/tests/workbench-terminal.test.ts`、`opencraft/apps/workbench-web/src/styles/app.scss` 的 Terminal Panel 段。

## scan_output
- 有界 `rg` 与源码片段；没有生成扫描产物。

## handoff
- 源码已改，聚焦测试、两端类型检查与独立 Web 构建通过；未重启或替换预览。手机内置浏览器的系统粘贴菜单需要用户在新预览实机确认。
