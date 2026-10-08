## goal
让 OpenCraft 排队消息的操作提示符合 `frontend/DESIGN.md` 的 Hover Tooltip 规范。

## non_goals
- 不改队列投递、排序或按钮动作语义；不提交、发布或修改生产。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户截图与本轮要求：更新排队消息操作按钮的 hover 展示框，参考 `frontend/DESIGN.md`。

## interface_refs / data_structure_refs
- `opencraft/packages/codex-composer/src/queue-tray.tsx` 的 `ComposerQueueTray`、操作按钮及 `portalContainer`。
- `opencraft/apps/workbench-web/src/styles/app.scss` 的排队托盘样式；embedded Shadow DOM 的 presentation root。

## history_context
- current_design_refs: `frontend/DESIGN.md` Hover Tooltip、`opencraft/docs/chat-ui-architecture.md`。
- relevant_evolution: 现有按钮与行使用原生 `title`；排队托盘具有滚动裁剪，embedded UI 位于 Shadow DOM。
- superseded_refs: 无。

## acceptance
- 排队消息操作提示为白底、轻边框、6px 圆角、11px 字体、轻阴影和底部小三角；hover 与键盘 focus 可见，文字可选择。
- 浮层脱离排队托盘裁剪；按钮的操作、禁用状态和可访问名称保持有效。
- 通过相关组件测试、类型检查和 embedded 构建；本地浏览器检查呈现。

## affected_paths
- `opencraft/packages/codex-composer/src/queue-tray.tsx`
- `opencraft/packages/codex-composer/package.json`
- `opencraft/package-lock.json`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/tests/chat-composer-queue.test.tsx`
- `opencraft/docs/chat-ui-architecture.md`

## required_context
- Context Router 未命中 Pack；有界精确搜索定位 `queue-tray.tsx` 与 `app.scss`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/DESIGN.md` | Tooltip 权威规范 | 视觉、交互与裁剪要求 |
| `opencraft/AGENTS.md` | OpenCraft 局部规则 | 验证与交接边界 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | 维护方法 | 真实界面验收 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | 验证入口 | 选择相关测试 |
| `opencraft/docs/chat-ui-architecture.md` | Composer 设计 | 正式设计同步 |

## evidence
- 截图中编辑按钮展示灰色原生 `title`；源码确认行和按钮使用 `title`，托盘 `overflow: hidden auto`。
- 排队操作及消息预览改为 Radix Tooltip；禁用按钮通过可聚焦的 group 触发提示，所有原生 `title` 已移除，按钮可访问名称保留。
- 临时 Vite 浏览器验收页在与 embedded 相同的 Shadow DOM、裁剪容器和 portal root 中显示 Tooltip。编辑按钮和禁用 Steer 的键盘焦点均打开提示；浏览器计算样式确认白底、1px 轻边框、6px 圆角、11px 字体、轻阴影、`pointer-events: auto`、`user-select: text`，提示节点不在排队托盘内。临时验收文件已移出仓库并停止服务。
- Composer 聚焦测试 9/9、embedded CI 176/176、Composer 和 Workbench 类型检查、边界检查、embedded release 构建通过；最终 JSX 调整后聚焦测试、Composer 类型检查和 release 构建再次通过。

## risks
- Embedded Shadow DOM 样式不作用于 `document.body` 浮层；使用现有 `portalContainer` 将提示挂到 presentation root。
- 5174 当前被另一个 LightVela worktree 的 Next 服务占用；真实 Chat 中的队列操作 tooltip 尚未直接验收。临时 Shadow DOM 组件预览覆盖布局与焦点，但不替代登录态对话。

## validation
- OpenCraft Composer 聚焦测试、Composer 与 Workbench 类型检查、embedded 构建、change-impact 检查，以及本地浏览器 hover/focus 检查。

## decisions
- 使用现有 Radix Tooltip 浮层能力并通过 `portalContainer` 渲染，避免手写定位与滚动同步。

## scan_scope
- `frontend/DESIGN.md` Hover Tooltip；`opencraft/packages/codex-composer/src/queue-tray.tsx`；`opencraft/apps/workbench-web/src/styles/app.scss`。

## scan_output
- 精确搜索命中上述文件；Context Router 查询无匹配 Pack。

## handoff
- 本地源码与 embedded 构建产物已更新；5174 属于另一 worktree，本任务未替换该服务。未提交、推送或发布。
