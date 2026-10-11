## goal
为删除 Bot 与删除整个 Agent 的共用确认弹窗显示异步删除中的状态。

## non_goals
- 不改变删除 API、权限或删除后的导航逻辑。
- 不合并或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-07 截图与请求：点击两个删除确认按钮后等待期间显示转圈图标。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-settings-page.tsx` 的 `handleDelete` 和共用确认弹窗。
- `frontend/src/contexts/agent-context.tsx` 的 `deleteBot` 等待 `repositories.bots.destroyBot`。

## history_context
- `current_design_refs`: 当前页面源码及 `frontend/openspec/`，本次为局部交互反馈。
- `relevant_evolution`: 当前主分支已共用主 Bot 和普通 Bot 的删除确认弹窗。
- `superseded_refs`: 无。

## acceptance
- 请求未完成时两个确认按钮显示转圈图标和“删除中...”，无法重复提交或关闭弹窗。
- 请求失败时停止转圈、恢复操作并保留错误提示；成功后弹窗关闭。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-labs-nav.test.tsx`

## required_context
- 路由器无匹配 Pack；首次按截图文案精确搜索无结果，随后在 `frontend/src/pages/marketing/` 找到处理函数。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | 仓库边界 | 验证与提交限制 |
| `frontend/AGENTS.md` | 最近服务入口 | 前端门禁 |
| `docs/context/tasks/TASK-TEMPLATE.md` | Task Pack 结构 | 本文件 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 前端邻接卡 | 检查现有文案和测试 |
| `frontend/openspec/spec.md` | 当前前端约束 | 确认无删除交互专用约束 |

## evidence
- `validate_context.py --route ...`：未匹配 Pack。
- `deleteBot` 等待 `repositories.bots.destroyBot` 后更新本地 Bot 列表。
- 聚焦组件测试：12/12 通过（临时配置将 Vitest 主机改为 `127.0.0.1`；系统 `localhost` 无法解析）。
- 完整测试已尝试：多个无关用例失败，worker OOM 后终止；未获得完整套件通过结果。
- `pnpm build` 通过；`pnpm typecheck` 在 MDX 生成后通过，0 个新增诊断。
- `pnpm lint` 无可运行脚本；`validate_change_impact.py --staged` 通过且无映射规则命中。
- `validate_documentation.py --format json` 通过：0 个第一方断链、0 个 warning。
- `git diff --check` 通过；构建生成改动和临时测试配置已清理。
- 提交 MR 前 `pnpm check` 通过；`npm --prefix opencraft run check:mono2-agent-console` 通过，130 个文件无漂移。

## risks
- 请求期间重复点击或关闭弹窗可能造成重复删除或状态不明；用按钮禁用和遮罩关闭守卫处理。

## validation
- 聚焦组件测试；前端 lint、typecheck、test、build；`git diff --check`。

## decisions
- 复用页面现有 `Loader2` 和已生成的“删除中...”翻译，不新增资源或通用组件。

## scan_scope
- `frontend/src/pages/marketing/`、相邻测试、`frontend/openspec/`、现有 i18n 键。

## scan_output
- 搜索结果仅用于定位，不保存扫描产物。

## handoff
- 实现与本地门禁已完成；用户随后明确要求提交 MR。完整测试受已有失败与 OOM 限制。
