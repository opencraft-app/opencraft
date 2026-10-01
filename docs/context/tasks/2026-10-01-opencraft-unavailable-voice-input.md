## goal
修复 OpenCraft 语音输入提示不可用时仍可由指针手势触发的问题。

## non_goals
- 不新增浏览器语音识别能力，也不修改识别结果处理。
- 不发布或修改生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户截图（2026-10-01）：麦克风 hover 显示“Voice input is unavailable in this browser”，但按钮仍可点击。

## interface_refs / data_structure_refs
- `SpeechInputProvider.isAvailable()` 决定语音按钮的不可用状态。
- `VoiceInputAction` 的 `disabled` prop 和 `onPointerDown`、`onClick` 是输入入口。

## history_context
- `current_design_refs`：`docs/engineering/domains/agent-gateway-runtime.md`、`opencraft/docs/chat-ui-architecture.md`。
- `relevant_evolution`：现有按钮已渲染 `disabled={disabled || !available}`，但指针手势处理此前未校验。
- `superseded_refs`：无。

## acceptance
- 浏览器不支持语音输入时，提示不可用，按钮表现为禁用，长按与点击均不进入语音流程。
- 可用平台的既有语音识别行为保持正常。

## affected_paths
- `opencraft/plugins/voice-input/src/voice-input-action.tsx`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/tests/voice-input-unavailable.test.tsx`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- 路由器未命中 Pack；先在 Composer 和语音输入插件做有界精确搜索。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@HEAD` | 仓库硬边界 | 隔离改动和验证 |
| `docs/context/tasks/TASK-TEMPLATE.md@HEAD` | Task Pack 格式 | 记录任务 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@HEAD` | 前端邻接 | 定位样式和测试 |
| `docs/engineering/domains/agent-gateway-runtime.md@HEAD` | 映射的正式设计 | 同步禁用态边界 |
| `opencraft/docs/chat-ui-architecture.md@HEAD` | ChatUI 当前设计 | 确认 Composer 职责 |

## evidence
- 截图英文提示在 `voice-input-action.tsx` 命中；插件的 `isAvailable()` 为 false 时原本设置了原生 `disabled`。
- 新增交互回归测试在修复前失败：对禁用按钮派发 `pointerdown` 后，`beginTransientTextInput` 被调用 1 次。
- 增加按下/点击入口校验和禁用态样式后，同一测试通过。
- 浏览器/原生语音相邻测试与新测试共 15 项通过；Voice Input 插件和 Workbench Web 类型检查通过；`npm run build:web` 成功。
- 直接运行 Workbench workspace build 曾因未先构建浏览器预览桥接文件失败；使用根包 `build:web` 按正确顺序构建成功。

## risks
- 部分浏览器仍会向禁用按钮派发指针事件；在处理函数内再次校验，保留 tooltip 供解释禁用原因。

## validation
- `opencraft/tests/voice-input-unavailable.test.tsx` 及相邻语音测试。
- Voice Input 插件与 Workbench Web 类型检查、相关构建或样式门禁。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`。

## decisions
- 保留不可用提示和原生 `disabled`；补上事件入口防线与视觉禁用态。

## scan_scope
- `opencraft/plugins/voice-input/src`、Composer 控件样式与语音测试。

## scan_output
- 无独立扫描产物。

## handoff
- 本地验证完成，待 owner 审阅；未提交、未推送、未发布。
