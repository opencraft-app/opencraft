## goal
将首次创建 Bot 的空状态按钮从“新建 Bot”调整为带前置加号图标的“新建”。

## non_goals
- 不修改已有 Bot 场景下的创建入口。
- 不修改创建流程、套餐额度判断、后端接口或部署配置。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户截图反馈（2026-09-20）：首次创建 Bot 的按钮文案改为“新建”，并在文案前增加 `+`。
- 交付目标：现有 Gongfeng MR `wisp/mono2!4321`。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-settings-page.tsx` 的首次创建空状态按钮。
- 保持 `handleCreateNew`、`canCreateInitialAgent`、`directCreating` 及禁用态逻辑不变。

## history_context
- `current_design_refs`：`frontend/DESIGN.md`。
- `relevant_evolution`：MR !4321 已包含 Agent 设置页相关调整，本次只追加首次创建按钮的展示文案与图标。
- `superseded_refs`：无。

## acceptance
- 可创建且非创建中时，按钮显示前置加号图标与“新建”。
- 创建中仍显示加载图标与“创建中...”。
- 不可创建时仍显示“暂不可创建”。
- 相关组件测试、前端检查与国内站构建通过。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx`
- `docs/context/tasks/2026-09-20-first-bot-create-button-copy.md`

## required_context
- 未匹配到 Domain Pack；按路由器要求执行前端目录的有界精确搜索。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@06b7baea` | 仓库级变更和交付边界 | 使用隔离 worktree，执行验证后提交到既有 MR |
| `frontend/AGENTS.md@06b7baea` | 前端实现与验证规范 | 确定前端测试、检查和构建门禁 |
| `frontend/DESIGN.md@06b7baea` | 前端交互与视觉规范 | 保持现有按钮样式和状态逻辑 |
| `docs/context/tasks/TASK-TEMPLATE.md@06b7baea` | Task Pack 结构要求 | 记录范围、证据和交接状态 |

## evidence
- 上下文路由：`python3 .agents/context/scripts/validate_context.py --route "frontend first Bot empty state create button label 新建 Bot + 新建"`，未匹配 Pack。
- 精确搜索定位到首次创建空状态按钮与现有组件测试；未扩大扫描范围。
- 新增按钮用例单独执行通过（1 passed），空状态源约束测试通过（3 passed）。
- 两个相关测试文件联合执行时，MR 原有套餐升级状态文案用例失败 1 项；期望“正在为 Hermes Agent 升级套餐”，实际为“正在升级您的 LightVela 套餐...”，与本次按钮改动无关。
- `pnpm check` 通过：i18n/文档检查通过，TypeScript `0 new` diagnostics。
- `pnpm build:cn` 通过：104 个静态页面完成生成，SEO 与静态资源检查通过。
- `validate_documentation.py` 通过：`errors=[]`、`warnings=[]`、无断链。
- `validate_change_impact.py --staged` 通过：无匹配规则，无额外 owner review 要求。

## risks
- 风险：误改其他“新建 Bot”入口或创建状态逻辑。
- 缓解：仅修改空状态可创建分支，并用组件测试约束图标和可访问名称。
- 回滚：回退本次单一提交即可恢复原展示。

## validation
- `pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx src/pages/marketing/__tests__/agent-settings-empty-persona.test.ts`
- `pnpm check`
- `pnpm build:cn`
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`
- `git diff --check`

## decisions
- 使用已有 `Plus` 图标组件，而不是把 `+` 作为文字拼入文案，保持图标与文字间距和语义清晰。
- 不调整同页其他创建入口，避免扩大需求范围。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/`

## scan_output
- 无独立扫描产物；结果记录在本 Task Pack 的 evidence 中。

## handoff
- 状态：实现与本地验证完成。
- 交付目标：MR !4321 源分支 `codex/upgrade-plan-polish`。
- 阻塞项：无。
