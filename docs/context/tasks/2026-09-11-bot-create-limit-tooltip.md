## goal
修复 Bot 达到数量上限时“新建 Bot”提示框被侧栏裁剪的问题，并将提示框放在按钮下方。

## non_goals
- 不修改 Bot 上限计算、套餐权限、提示文案或创建流程。
- 不调整侧栏整体滚动行为。
- 不提交、发布或操作生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户截图：达到 Bot 限制时，新建按钮置灰提示被遮挡，且期望提示框位于按钮下方。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-settings-page.tsx`：`WorkspaceActionTooltip` 与新建 Bot 入口。
- 保持 `getOpenClawCreateLimitMessage` 和 `resolveOpenClawCreatePermissions` 既有语义。

## history_context
- `current_design_refs`：`frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/src/styles.css`。
- `relevant_evolution`：现有提示框以 `absolute bottom-full` 渲染在 `.lv-agents-sidebar-scroll-isolated` 内；后者在桌面端使用 `overflow-y: auto`。
- `superseded_refs`：无。

## acceptance
- 达到 Bot 上限时按钮仍置灰，提示文案不变。
- hover 和键盘聚焦可打开提示框；浮层渲染至 `document.body`，使用 fixed 定位并位于按钮下方。
- 提示框水平位置受视口边界约束，不被侧栏滚动容器裁剪。
- 相关组件测试、`pnpm check` 和 `git diff --check` 通过。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-diagnostics-multi-bot.test.tsx`
- `docs/context/tasks/2026-09-11-bot-create-limit-tooltip.md`

## required_context
- Router 未命中 Pack；执行有界精确搜索。
- `frontend/AGENTS.md`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md` | 最近服务级约束 | 确认视觉变更需聚焦截图或组件测试 |
| `.agents/skills/feai-native/SKILL.md` | 当前 change 工作流 | 遵守 shape/build/verify/archive 阶段 |
| `.agents/skills/karpathy-guidelines/SKILL.md` | 代码改动约束 | 保持改动最小且可验证 |
| `.agents/skills/baseline-ui/SKILL.md` | UI 基线 | 保持键盘可用、固定 z-index 和既有样式系统 |

## evidence
- Context router query `fix multi-bot create limit disabled button tooltip clipping and place tooltip below button in frontend` 未命中 Pack。
- Graphify 查询定位到 `WorkspaceActionTooltip`、`AgentSettingsPage` 和额度判断测试。
- 源码确认提示框为 `absolute bottom-full`，侧栏容器为 `overflow-y: auto`。
- 聚焦 Vitest：2 files / 41 tests passed；覆盖按钮置灰、Portal 挂载、下方坐标、箭头方向、hover、focus、Escape 与 ARIA 关联。
- `pnpm check`：通过，TypeScript 174 current / 276 baseline / 0 new。
- 本地 Next 页面：HTTP 200、有内容、无错误覆盖层、无 console error；隐藏的新建入口未在浏览器会话开放，未形成真实额度提示截图。
- 文档校验、17 个实际文件的 change-impact 检查及 `git diff --check` 通过。

## risks
- Portal 改变提示框 DOM 层级；通过组件测试验证 body 挂载及 ARIA 关联。
- 视口窄时可能横向越界；通过位置函数边界测试和 max-width 约束缓解。

## validation
- 聚焦 Vitest 组件测试。
- `pnpm check`。
- `git diff --check`。

## decisions
- 使用现有 React Portal 能力，不新增依赖。
- 仅“新建 Bot”额度提示指定下方；其他 `WorkspaceActionTooltip` 调用保持默认上方。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-diagnostics-multi-bot.test.tsx`
- `frontend/src/styles.css`

## scan_output
- 有界源码搜索与 Graphify 查询结果，无额外产物。

## handoff
- 当前状态：实现与验证完成，等待用户决定是否归档。
- 未 commit、push、创建 MR、发布或现网回归。
