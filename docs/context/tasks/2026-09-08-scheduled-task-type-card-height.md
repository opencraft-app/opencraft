## goal
让新建定时任务弹窗中的三种任务类型卡片在桌面端同一行内保持等高，并让内部标题和说明统一从顶部开始排布，不再因描述文案换行不同而出现高度或基线错位。

## non_goals
- 不修改任务类型、交互或后端行为；仅修正用户明确指出的不准确英文说明。
- 不使用固定高度限制多语言文案。
- 不改动移动端单列布局。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户截图反馈（2026-09-08）：三张任务类型卡片高度不一致，自适应逻辑不应导致同组产品卡片高度不同。
- 用户截图反馈（2026-09-08）：通知任务“不调用模型”的英文说明表达不准确。

## interface_refs / data_structure_refs
- `AutomationFormModal` 的任务类型选择按钮；保持现有 `CreateTaskKind`、`aria-pressed` 与点击行为不变。

## history_context
- `current_design_refs`：`frontend/DESIGN.md`、`frontend/openspec/specs/marketing.md`。
- `relevant_evolution`：`1a796afac` 引入三列任务类型卡片时显式设置了 `items-start`，使同一网格行中的卡片按内容独立收缩。
- `superseded_refs`：无。

## acceptance
- 桌面端三列卡片由同一网格行统一拉伸到该行最高内容的高度。
- 三张卡片的内部内容统一顶部对齐，标题基线不随说明行数变化。
- 说明文案继续自然换行，不增加固定高度或最小高度。
- 中文与国际站共享实现和测试均通过。

## affected_paths
- `frontend/src/pages/marketing/agent-automations-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts`
- `frontend/src/pages/marketing/__tests__/agent-automations-panel.global.test.ts`
- `frontend/src/i18n/generated/en-US.json`
- `docs/context/tasks/2026-09-08-scheduled-task-type-card-height.md`

## required_context
- 路由查询 `frontend Scheduled Tasks job type cards equal height responsive modal` 未命中 Pack；按规则完成有界精确搜索。
- `frontend/AGENTS.md`、`frontend/DESIGN.md`、`docs/context/project/services/frontend.md`、`docs/context/project/adjacency/frontend-runtime-openspec-i18n.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@474dfecef` | 最近服务规则 | 确定视觉变更需组件测试或截图证据 |
| `frontend/DESIGN.md@474dfecef` | 前端视觉规范 | 保持产品型弹窗布局与既有圆角、密度一致 |
| `docs/context/project/services/frontend.md@2.1.0` | 前端验证边界 | 选择聚焦组件测试和类型检查 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 相邻测试约束 | 核查实现、OpenSpec 与相邻测试 |
| `frontend/openspec/specs/marketing.md@474dfecef` | 当前功能规格 | 确认不改变任务类型业务行为 |

## evidence
- 回归测试先将预期改为 `items-stretch`，修复前聚焦用例按预期失败，实际类名为 `items-start`。
- 将任务类型网格从 `items-start` 改为 `items-stretch`；按钮内容和交互未改。
- 截图复查发现等高按钮仍由浏览器默认垂直居中；新增 `flex flex-col justify-start` 回归预期，修复前用例按预期失败，随后统一为顶部对齐。
- 英文“通知任务”说明从含糊的 `Sends notifications as-is; no model` 修正为 `Sends notifications as written, without calling a model`，明确表达不发起模型调用；英文回归测试先失败后通过。
- 中英文任务面板聚焦测试共 170 个用例通过。
- `pnpm check` 通过：i18n、文档同步、MDX 与 TypeScript 基线均通过，0 个新增诊断；顶部对齐跟进后再次运行 `pnpm typecheck`，仍为 0 个新增诊断。
- `pnpm lint` 无法运行：当前 `frontend/package.json` 未定义 `lint` 脚本，依赖中也没有 ESLint 可执行文件。
- 文档完整性校验通过：0 个 first-party 断链、0 个 warning。
- staged change-impact 校验通过：5 个目标文件，无匹配的额外设计文档更新要求。
- i18n 提取检查与结构校验通过；现有 51 个告警未因本次英文译文变更增加错误。

## risks
- 长文案可能继续换行；通过网格行拉伸而非固定高度吸收差异。
- 移动端为单列多行；仅在桌面三列时形成同一行等高，不强迫不同网格行等高。

## validation
- 聚焦运行 `agent-automations-panel.test.ts` 与 `agent-automations-panel.global.test.ts`。
- 运行前端 `pnpm check`。
- 运行 `git diff --check` 与 staged change-impact 校验。

## decisions
- 使用网格交叉轴的 `items-stretch`，不增加 `h-*` / `min-h-*`，避免多语言文案被固定尺寸约束。
- 卡片按钮使用纵向 Flexbox 和 `justify-start`，覆盖浏览器对等高按钮内容的默认垂直居中行为。

## scan_scope
- `frontend/src/pages/marketing/agent-automations-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-automations-panel*.test.ts`
- `frontend/openspec/`

## scan_output
- 精确命中任务类型选择器、相邻测试与 marketing OpenSpec；未发现独立业务组件或生成物。

## handoff
- 实现与本地验证完成；代码、测试、英文译文和本 Task Pack 将提交到 `frontsandbox/rename-automations-to-scheduled-tasks`，并创建指向 `master` 的 MR；不执行合并或发布。
