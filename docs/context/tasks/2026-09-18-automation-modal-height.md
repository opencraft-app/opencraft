## goal
让新建和编辑定时任务弹窗在桌面视口中露出「高级设置」入口，并在展开后通过可见滚动条访问底部内容。

## non_goals
- 不改动表单字段、任务执行逻辑和通知配置。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户截图（2026-09-18）：底部「高级设置」入口被操作区遮挡，要求增大弹窗高度。
- 用户后续反馈（2026-09-18）：希望弹窗再稍高一点。

## interface_refs / data_structure_refs
- 无 API 或数据结构变更。

## history_context
- `current_design_refs`：`frontend/DESIGN.md` 的 Modal Layout；`frontend/openspec/changes/2026-08-28-automation-form-test-run-design.md` 定义底部测试运行操作区。
- `relevant_evolution`：当前表单使用固定高度、内部滚动和固定底部操作区。
- `superseded_refs`：无。

## acceptance
- 桌面弹窗固定高度从 720px 增至 840px；较矮视口保留上下各 8px 空隙，以 `100dvh - 16px` 为上限。
- 展开高级设置后，内容区右侧出现可见且可拖动的滚动条，底部控件可滚动到完整显示；操作区保持固定。
- 定时任务表单的聚焦组件测试及前端检查通过。

## affected_paths
- `frontend/src/pages/marketing/agent-automations-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts`

## required_context
- `validate_context.py` 无匹配 Pack，按要求执行有界精确搜索。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@origin/master` | 服务门禁 | 验证范围 |
| `frontend/DESIGN.md@origin/master` | 弹窗布局规范 | 保留操作区和滚动结构 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@origin/master` | 前端邻接卡 | 检查相邻测试和 OpenSpec |
| `frontend/openspec/changes/2026-08-28-automation-form-test-run-design.md@origin/master` | 底部操作区约束 | 保留测试运行入口位置 |
| `docs/context/flows/tapd-gongfeng-delivery.md@origin/master` | MR 交付门禁 | 核对授权与远端状态 |
| `docs/context/flows/change-delivery.md@origin/master` | Task Pack 交接 | 记录最终验证与范围 |

## evidence
- `origin/master` 当前弹窗使用 `h-[720px] max-h-[calc(100dvh-32px)]`，内容区独立滚动。
- 聚焦组件测试：197/197 通过。
- `pnpm check` 通过，TypeScript 诊断 0 个新增；`pnpm build` 通过。
- `validate_documentation.py --repo . --format json` 通过，首方链接错误 0；`git diff --check` 通过。
- `pnpm test` 出现模型配置、支付、文档等无关模块失败，随后一个 worker 长时间占满 CPU 且不再推进，手动中止；不能视为全套通过。
- 将高度改动合入提供 5174 预览的 worktree 后，Chrome 本地开发资源（`/_next/static/`）实测视口 1728×936，弹窗高度 800px，「高级设置」摘要位于内部滚动区底部上方 63.5px，完整可见且可展开。用户的 `lightvela.com` Chrome 标签加载 `__releases/` 正式站资源，仍为 720px。
- 合并预览 worktree 的聚焦测试 199/199 通过，`pnpm check` 与 `pnpm build:cn` 通过，5174 页面 HTTP 200。
- 用户展开高级设置后仍看到底部控件被挡；原内容区显式设置 `scrollbar-width:none` 和隐藏 WebKit 滚动条。macOS Chrome 对原生滚动条使用悬浮隐藏行为，因此改用仓库现有 Radix ScrollArea，`type="always"`。
- Chrome 5174 本地预览实测高级设置展开后右侧出现 10px 滚动条，可点选底部「上游任务」并滚动至底，操作区保持固定。组件测试 197/197 与 `pnpm build:cn` 通过。
- 后续在 736px 高的 Chrome 视口实测：弹窗受新上限约束，实际高度 720px，距上下边缘各 8px；旧上限下只有 704px。高级设置展开后右侧 10px 滚动条仍可用。最终聚焦测试 197/197、`pnpm check`、`pnpm build:cn` 通过。

## risks
- 较矮视口弹窗接近满屏；`max-h` 和滚动区继续保证可用，回滚为原高度即可。

## validation
- 聚焦 `agent-automations-panel.test.ts`。
- `pnpm check`、`pnpm test`、`pnpm build`。当前 `frontend/package.json` 没有 `lint` 脚本。

## decisions
- 固定高度调整为 840px，较矮视口缩小上下留白；固定底部操作区与现有 ScrollArea 可拖动滚动条保持不变。

## scan_scope
- `frontend/src/pages/marketing/agent-automations-panel.tsx` 及邻近测试和 OpenSpec。

## scan_output
- 有界搜索命中弹窗固定高度与三处测试断言。

## handoff
- 用户已确认 5174 国内站本地预览并授权提交 MR；本记录不代表已合并或发布。全套测试此前出现无关失败并中止，聚焦测试与前端检查通过。
