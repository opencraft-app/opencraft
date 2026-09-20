## goal
让新建与编辑自动任务弹窗在高级设置收起时更紧凑，展开后增高，并在视口高度不足时通过内容区纵向滚动保持全部字段与操作可达。

## non_goals
- 不改变任务字段、保存逻辑、测试运行逻辑或高级设置内容。
- 不修改弹窗宽度、按钮样式或自动任务列表布局。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-09-19 反馈：当前弹窗过高，高级设置与按钮之间空白过大；展开高级设置后应增加高度，浏览器高度不足时右侧显示上下滚动条；新建与编辑均需调整。
- 用户 2026-09-20 视觉复核后将高级设置收起高度从 740px 增加 15px，最终为 755px。
- 用户 2026-09-20 要求缩小通知方式与高级设置之间的空白间距。
- 用户 2026-09-20 要求移除周期任务时间输入中的时钟图标，并收窄时间输入框。
- 用户 2026-09-20 要求去除时间文字与删除按钮之间的残留空白。
- 用户 2026-09-20 视觉复核后要求进一步去掉分钟输入右侧的内边距。

## interface_refs / data_structure_refs
- `AutomationFormModal` 同时承载 `mode="create"` 与 `mode="edit"`。
- `executionMode === "agent"` 时渲染原生 `details` 高级设置区。
- 表单内容使用共享 `ScrollArea`，底部操作区位于滚动区之外。

## history_context
- `current_design_refs`：`frontend/DESIGN.md` Modal Layout；`frontend/src/components/ui/scroll-area.tsx`。
- `relevant_evolution`：MR !4268 将弹窗统一为 840px 固定高度并增加 Radix 纵向滚动条，解决高级设置被遮挡；本轮在此基础上收紧默认态并按展开状态增高。
- `superseded_refs`：旧的 840px 全状态固定高度仅供回溯。

## acceptance
- 新建和编辑智能任务弹窗默认高度低于当前 840px，高级设置与底部按钮之间不再出现大块空白。
- 展开高级设置后弹窗高度增加；再次收起恢复紧凑高度。
- 弹窗高度不超过视口可用高度，内容溢出时显示纵向滚动条，底部操作区固定可见。
- 聚焦测试、`pnpm check`、国内站构建与本地 5174 视觉检查通过。

## affected_paths
- `frontend/src/pages/marketing/agent-automations-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts`

## required_context
- Pack `frontend-product-surface`；最近服务级 `frontend/AGENTS.md`；前端邻接卡。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@3bc843130` | 路由器 must_read | 确认前端验证与双站边界 |
| `frontend/AGENTS.md@3bc843130` | 服务门禁 | 确认组件复用和验证命令 |
| `frontend/DESIGN.md@3bc843130` | 弹窗设计约束 | 保持标题、内容与固定操作区结构 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@3bc843130` | 邻接检查 | 选择相邻组件测试与构建验证 |
| `frontend/src/components/ui/scroll-area.tsx@3bc843130` | 现有滚动组件 | 复用 Radix ScrollArea，不新增滚动实现 |

## evidence
- 最新 `origin/master` 中 `AutomationFormModal` 对新建、模板和编辑常见场景统一使用 `h-[840px] max-h-[calc(100dvh-16px)]`。
- 高级设置使用非受控 `details`，弹窗当前无法根据展开状态调整高度。
- 底部操作区已在 `AutomationFormScrollArea` 之外，可保持固定。
- 实现后聚焦测试 197/197 通过；`pnpm check` 通过且新增 TypeScript 诊断为 0；`pnpm build:cn` 通过并生成 103 个静态页面。
- Chrome 5174 国内站在 933px 高视口实测：收起状态弹窗使用 755px；展开状态继续使用 840px，视口不足时仍由 `100dvh - 16px` 上限和内容区滚动保证字段可达。
- 通知方式后的高级设置区顶部间距由 12px 缩小为 4px，减少周期任务场景下标注区域的留白。
- 周期任务时间输入移除时钟选择按钮，并取消固定宽度和内部伸缩，让容器按时间文字与删除按钮的实际内容自然收缩，保留直接编辑和删除时间点能力。
- 周期任务时间输入只保留左侧内边距，删除分钟输入与删除按钮之间的右侧内边距。

## risks
- 高度切换可能让低视口内容不可达；继续保留视口上限和内容区滚动。
- 新建、编辑及模板入口共享组件；聚焦测试覆盖三类入口和高级设置切换。

## validation
- `pnpm exec vitest run --config vitest.config.ts --api.host 127.0.0.1 src/pages/marketing/__tests__/agent-automations-panel.test.ts`
- `pnpm check`
- `pnpm build:cn`
- 本地 5174 新建与编辑弹窗视觉检查。

## decisions
- 用受控高级设置展开状态选择紧凑与展开高度，保留现有固定 footer 和 Radix 内容滚动区。
- 滚动条改为内容溢出时出现，避免内容完全可见时仍显示轨道。

## scan_scope
- 自动任务表单组件、ScrollArea primitive、相邻测试与 MR !4268 历史差异。

## scan_output
- 精确搜索命中 `AutomationFormModal`、`AutomationFormScrollArea`、`shouldKeepFormHeight` 与三处 840px 断言。

## handoff
- 本地实现与验证完成，用户已授权提交 MR；尚未合并或发布。
