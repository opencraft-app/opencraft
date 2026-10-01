## goal
修复 OpenCraft 排队消息按钮的 hover 提示，显示按钮操作而不是消息正文。

## non_goals
- 不修改排队、插入、编辑或删除的执行逻辑。
- 不发布或修改生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户截图（2026-10-01）：删除等按钮 hover 时错误显示“几点了”，应显示按钮操作。

## interface_refs / data_structure_refs
- `opencraft/packages/codex-composer/src/queue-tray.tsx`：`ComposerQueueTrayItem.preview` 与各操作按钮。
- `opencraft/apps/workbench-web/src/i18n/locales/zh-CN.json`：中文 UI 文案。

## history_context
- `current_design_refs`：`opencraft/docs/chat-ui-architecture.md` 排队消息与操作边界；`docs/engineering/domains/agent-gateway-runtime.md`。
- `relevant_evolution`：无须依赖历史变更；当前 DOM 的父级 `title` 已足以解释问题。
- `superseded_refs`：无。

## acceptance
- hover 排序、插入、编辑、取消编辑、删除按钮时，提示为对应操作。
- hover 消息本身时仍可查看消息正文或状态信息。
- `opencraft/tests/chat-composer-queue.test.tsx` 覆盖中文按钮提示。

## affected_paths
- `opencraft/packages/codex-composer/src/queue-tray.tsx`
- `opencraft/apps/workbench-web/src/i18n/locales/zh-CN.json`
- `opencraft/tests/chat-composer-queue.test.tsx`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- 路由器未命中 Pack；先在 OpenCraft 目录完成有界精确搜索。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@HEAD` | 仓库边界 | 隔离改动与验证门禁 |
| `docs/context/tasks/TASK-TEMPLATE.md@HEAD` | 任务记录格式 | 创建本 Task Pack |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@HEAD` | 前端 i18n 邻接 | 检查 locale 与测试邻居 |
| `docs/engineering/domains/agent-gateway-runtime.md@HEAD` | 映射的正式设计 | 同步 Composer 操作提示边界 |
| `opencraft/docs/chat-ui-architecture.md@HEAD` | 当前队列设计 | 确认操作边界 |
| `opencraft/tests/chat-composer-queue.test.tsx@HEAD` | 测试邻居 | 添加回归验证 |

## evidence
- 初次在旧检出 `frontend opencraft` 搜索截图占位文案无结果；独立 worktree 中在 `opencraft/apps/workbench-web` 命中 `chat.companionFollowupPlaceholder`。
- `queue-tray.tsx` 父级 `title={item.error ?? item.pausedReason ?? item.preview}`；编辑、删除按钮此前无 `title`。
- `node --import tsx --test tests/chat-composer-queue.test.tsx`：9/9 通过，包括中文操作提示回归。
- Composer 与 Workbench Web `typecheck`、`check:i18n`、文档校验和 staged 变更影响校验均通过；`git diff --check` 无错误。

## risks
- 浏览器原生 tooltip 会继承祖先 `title`；给操作按钮显式 `title` 并通过渲染测试验证。

## validation
- `opencraft/tests/chat-composer-queue.test.tsx`
- `opencraft` Composer 类型检查、i18n 检查与相关 lint 门禁。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`

## decisions
- 保留队列行的消息正文提示，操作按钮单独提供本地化 `title` 与无障碍名称。

## scan_scope
- `opencraft/packages/codex-composer/src/queue-tray.tsx`、`opencraft/tests/chat-composer-queue.test.tsx`、Workbench 中文 locale。

## scan_output
- 无独立扫描产物。

## handoff
- 本地验证完成；待 owner 审阅。未提交、未推送、未发布。
