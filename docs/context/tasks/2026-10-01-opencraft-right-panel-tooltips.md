## goal
核查并补齐 OpenCraft 右侧预览面板图标按钮的 hover 操作提示。

## non_goals
- 不改变右侧面板按钮的实际操作、布局和文件路径提示。
- 不修改生产环境或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-01：“帮忙检查一下右边栏的按钮的hover提示对么”。此处按右侧预览面板理解。

## interface_refs / data_structure_refs
- `right-panel.tsx` 标签关闭动作及 `panel.closeTab` 文案。
- `thread-composer-presentation.tsx` 浮动输入框切换与收起/展开状态。
- `browser-device-toolbar.tsx` 浏览器视口缩放手柄。

## history_context
- `current_design_refs`：`docs/engineering/domains/agent-gateway-runtime.md`、`opencraft/docs/chat-ui-architecture.md`。
- `relevant_evolution`：沿用已有按钮 `aria-label`，使可见 hover 提示与其一致。
- `superseded_refs`：无。

## acceptance
- 关闭标签页显示“关闭 {title}”；浮动输入框切换、收起/展开和视口缩放手柄显示各自操作。
- 已有新建、放大、浏览器工具栏提示保持正确；文件树显示完整路径。

## affected_paths
- `opencraft/apps/workbench-web/src/components/right-panel.tsx`
- `opencraft/apps/workbench-web/src/components/thread-composer-presentation.tsx`
- `opencraft/apps/workbench-web/src/browser/browser-device-toolbar.tsx`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- 路由器未命中 Pack；在 Workbench 右侧面板相关目录完成有界精确搜索。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@HEAD` | 仓库验证与变更边界 | 控制本次改动 |
| `docs/context/tasks/TASK-TEMPLATE.md@HEAD` | Task Pack 格式 | 记录任务 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@HEAD` | 前端与翻译邻接 | 核对按钮文案和测试入口 |
| `docs/engineering/domains/agent-gateway-runtime.md@HEAD` | 映射的正式设计 | 同步 UI 提示边界 |
| `opencraft/docs/chat-ui-architecture.md@HEAD` | 当前 ChatUI 设计 | 限定面板职责 |

## evidence
- 面板顶部工具按钮、标签创建菜单、放大/还原和浏览器工具栏已提供操作 `title`。
- 关闭标签按钮、浮动输入框切换/收起/展开按钮及视口缩放手柄此前只有 `aria-label`，无可见 hover 提示。
- Workbench Web `typecheck`、`check:i18n`、`workbench-panels.test.ts` 与 `workbench-window-chrome.test.ts` 共 30 项通过；`git diff --check` 无错误。

## risks
- 浏览器原生 tooltip 可能因 `title` 缺失而不显示；补齐相同操作文案，保持 `aria-label` 一致。

## validation
- Workbench Web 类型检查、右侧面板相关测试及 i18n 检查。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`。

## decisions
- 保留文字按钮和文件树路径提示，仅补齐缺失的图标按钮提示。

## scan_scope
- `opencraft/apps/workbench-web/src/components/right-panel.tsx`、右侧面板注册的浏览器/终端/文件/侧聊面板。

## scan_output
- 无独立扫描产物。

## handoff
- 本地验证完成，待 owner 审阅；未提交、未推送、未发布。
