## goal
修复定时任务创建弹窗中单次执行时间选择面板被弹窗遮罩覆盖、无法操作的问题。

## non_goals
- 不修改定时任务调度格式、表单提交逻辑或后端接口。
- 不调整周期和按间隔两种执行时间控件。
- 不提交、推送、发布或变更生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户截图与文字反馈（2026-09-11）：定时任务弹窗中的时间选择器显示在弹窗后面，导致无法选择时间。

## interface_refs / data_structure_refs
- `OncePicker` 继续输出 `YYYY-MM-DDTHH:mm`，保持 `buildScheduleString` 的输入契约不变。

## history_context
- `current_design_refs`：`docs/context/tasks/2026-09-06-zero-token-automation-tasks.md` 规定单次执行时间使用站内受控日期时间弹层。
- `relevant_evolution`：`1a796aface` 引入受控 `OncePicker`；当前 `PopoverContent` 通过 Portal 挂载并默认使用 `z-50`，低于表单弹窗的 `z-[200]`。
- `superseded_refs`：浏览器原生 `input[type="datetime-local"]` 仅用于解释历史问题，不作为当前实现方案。

## acceptance
- 打开“单次”执行时间后，日期时间面板使用高于表单弹窗的嵌套浮层层级。
- 日期、小时、分钟与取消、确认操作保持可达。
- 聚焦组件测试、前端 lint、typecheck、test 与 build 通过。

## affected_paths
- `frontend/src/pages/marketing/agent-automations-panel.tsx`
- `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`
- `docs/context/tasks/2026-09-11-fix-automation-time-picker-layer.md`

## required_context
- 未命中 Domain Pack；已执行 bounded exact search。
- `frontend-service-detail`
- `adjacency-frontend-runtime-openspec-i18n`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@c8463caad` | 仓库硬边界与 Task Pack 规则 | 约束隔离、验证与交付边界 |
| `frontend/AGENTS.md@c8463caad` | 前端服务门禁 | 确定测试与截图要求 |
| `docs/context/project/services/frontend.md@2.1.0` | 前端服务边界 | 确定实现与正式上下文范围 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 相邻实现与测试入口 | 核对 Popover、组件测试与无 i18n 变更 |
| `docs/context/tasks/2026-09-06-zero-token-automation-tasks.md@c8463caad` | 当前单次时间选择器设计 | 保持站内受控弹层和草稿确认契约 |

## evidence
- 源码定位：表单遮罩 `z-[200]`；通用 `PopoverContent` 默认 `z-50`。
- 用户截图：日期时间面板出现在表单弹窗后方。
- 本地浏览器：表单计算层级为 `200`，时间面板为 `210`；选择 `2026-09-12 11:30` 后确认写回成功，用户现场确认显示正常。
- 验证报告：`/tmp/lightvela-validation/automation-time-picker-layer-2026-09-11/report.html`。

## risks
- 风险：提高全局 Popover 层级可能影响其他页面；缓解：仅在 `OncePicker` 实例覆盖为现有嵌套浮层层级 `z-[210]`。
- 回滚：移除该实例的 `z-[210]` 覆盖及对应断言。

## validation
- PASS：`pnpm exec vitest run src/pages/marketing/__tests__/automation-skill-picker.test.tsx`（21/21）。
- PASS：`pnpm check`（i18n、文档同步与 typecheck 基线无新增诊断）。
- PASS：`pnpm build`（97 个静态页面生成完成）。
- BASELINE FAIL：`pnpm test`（242 个文件通过、15 个文件失败、1 个跳过；75 个失败用例均位于本次未修改区域，另有 Vitest worker 4 GB OOM）。
- PASS：本地桌面浏览器打开定时任务表单，面板完整可见，日期、小时、分钟和确认写回均可操作。

## decisions
- 只覆盖单次时间 Popover 的层级，不修改通用 Popover 默认值，避免扩大回归面。
- 使用现有嵌套浮层层级 `z-[210]`，高于表单 `z-[200]` 且低于 Toast/Tooltip 层级。
- FE-AI Native 因 master 中已共享但未结束的 `upgrade-feai-tools-058` 拒绝创建本次 change；未接管或改写该无关状态，按 skill fallback 使用独立分支与 Task Pack 完成。

## scan_scope
- `frontend/src/pages/marketing/agent-automations-panel.tsx`
- `frontend/src/components/ui/popover.tsx`
- `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`

## scan_output
- 无独立扫描产物；精确搜索确认仅 `OncePicker` 需要覆盖 Portal 层级。

## handoff
- 已完成最小实现和本地验证；未 commit、push、创建 MR 或发布，线上生产环境尚未回归。
