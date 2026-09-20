## goal
让新建与编辑自动任务弹窗在高级设置收起时更紧凑，展开后增高，并在视口高度不足时通过内容区纵向滚动保持全部字段与操作可达。

## non_goals
- 不改变测试运行逻辑、高级设置内容、智能任务或脚本任务的通知方式可选规则。
- 不修改按钮样式或自动任务列表布局。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-09-19 反馈：当前弹窗过高，高级设置与按钮之间空白过大；展开高级设置后应增加高度，浏览器高度不足时右侧显示上下滚动条；新建与编辑均需调整。
- 用户 2026-09-20 视觉复核后将高级设置收起高度从 740px 增加 15px，最终为 755px。
- 用户 2026-09-20 要求缩小通知方式与高级设置之间的空白间距。
- 用户 2026-09-20 要求移除周期任务时间输入中的时钟图标，并收窄时间输入框。
- 用户 2026-09-20 要求去除时间文字与删除按钮之间的残留空白。
- 用户 2026-09-20 视觉复核后要求进一步去掉分钟输入右侧的内边距。
- 用户 2026-09-20 要求将弹窗宽度增加 15px。
- 用户 2026-09-20 要求稍微缩小周期任务的单个时间输入框。
- 用户 2026-09-20 要求将通知方式移动到任务说明框下方，并同时覆盖编辑弹窗。
- 用户 2026-09-20 要求将生效时间段移动到调用技能上方。
- 用户 2026-09-20 要求恢复定时任务空状态的时钟图标，并增加可直接打开新建弹窗的内联“新建”入口。
- 用户 2026-09-20 要求将调用技能选择框高度缩小，与名称输入框保持一致，并同时覆盖新建和编辑弹窗。
- 用户 2026-09-20 要求通知任务必须选择至少一种通知方式；新建和编辑弹窗移除通知方式的“可选”标记，未选择时保持提交按钮禁用并在悬浮时提示“未选择通知方式”。
- 用户 2026-09-20 要求精简通知任务说明，明确按原文发送且不产生模型调用，删除 Agent 运行资源相关表述。
- 用户 2026-09-20 反馈调用技能下拉列表会被弹窗滚动区和底部操作栏遮挡，要求新建和编辑弹窗中保持列表完整可见。
- 用户 2026-09-20 反馈上游任务下拉列表存在相同遮挡，要求同步修复。

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
- 通知任务在名称和通知内容完整、但未选择通知方式时仍不可新建或保存；悬浮禁用按钮显示原因，选择任一可用通知方式后恢复提交。
- 聚焦测试、`pnpm check`、国内站构建与本地 5174 视觉检查通过。

## affected_paths
- `frontend/src/pages/marketing/agent-automations-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts`
- `frontend/src/content/docs/configuration/automation.md`
- `frontend/src/content/docs/global/configuration/automation.md`
- `frontend/src/i18n/generated/*.json`

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
- 新建、模板新建和编辑共用弹窗的最大宽度由 800px 增加到 815px，并继续受 `w-full` 约束。
- 周期任务的小时和分钟输入段各由 28px 缩小到 24px，单个时间框整体缩短约 8px。
- 通知方式移动到任务说明或零 Token 内容区之后；生效时间段移动到调用技能之前，新建、模板新建和编辑共用同一顺序。
- 空状态恢复历史版本的 `Clock` 图标，文案增加“或直接新建”，内联“新建”复用现有 `requestCreate` 流程。
- 调用技能选择框最小高度由 40px 调整为 38px，与名称输入框的计算高度一致；新建和编辑共享该控件。
- 通知任务的提交条件新增至少一个 `deliverPlatforms`；通知方式标签仅在智能任务和脚本任务中保留“可选”，提交按钮通过 Portal Tooltip 解释未选择通知方式的禁用原因。
- 新建与编辑通知任务回归覆盖名称、内容完整但未选择通知方式时禁用提交，选择任一已配置通道后恢复提交；复制通知任务同样保留已选通道。
- Chrome 5174 国内站实测通知任务标签不再显示“可选”，无已配置通道时填写完整内容后“新建”仍置灰，聚焦按钮显示“未选择通知方式”。
- 通知任务说明更新为“通知内容会按原文发送，不经过模型改写，不产生模型调用。”，并同步六种目标语言资源和表单回归断言。
- 调用技能列表改为基于表单控件定位的 Portal 浮层，优先向上展开并使用可用视口高度限制，避免被表单滚动区或固定底部操作栏裁切；新建和编辑共用该组件。
- 上游任务列表同步改为 Portal 浮层，优先向上展开并限制在可用视口内，避免高级设置区域和固定底部操作栏裁切。
- 最终相关测试 4 个文件 237/237 通过，`pnpm check` 通过且新增 TypeScript 诊断为 0，`pnpm build:cn` 通过并生成 103 个静态页面。

## risks
- 高度切换可能让低视口内容不可达；继续保留视口上限和内容区滚动。
- 新建、编辑及模板入口共享组件；聚焦测试覆盖三类入口和高级设置切换。
- 通知通道可能仍在加载或没有已配置通道；通知任务保持不可提交并保留前往通道配置入口。

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
