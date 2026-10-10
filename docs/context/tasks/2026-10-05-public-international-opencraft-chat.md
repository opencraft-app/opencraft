## goal
国际站控制台 Chat 默认展示 OpenCraft，不再受浏览器控制台 `show()` 开关控制。

## non_goals
- 不改变其他由 `show()` 控制的隐藏工具。
- 不改变认证、Bot/Profile 归属、OpenCraft 会话协议或生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户后续要求：“去掉show（）隐藏 直接对外”。
- 前序国际站 OpenCraft 迁移已在 MR !5000 合并；本轮仅撤销其 Chat 展示门禁。

## interface_refs / data_structure_refs
- `agent-settings-page.tsx` 的 `openCraftChatEnabled` 控制 Chat 入口、侧栏会话和 `AgentChatMigrationSurface.enabled`。
- `console-show-event.ts` 的持久化开关继续服务其他隐藏工具；不得让它卸载 Chat。

## history_context
- current_design_refs: `docs/engineering/domains/site-environment-routing.md` 的“双站控制台 Chat”。
- relevant_evolution: `origin/master@b2a4d7ae0` 包含已合并的 MR !5000，国际站 Chat 原受 `show()` 控制。
- superseded_refs: `docs/context/tasks/2026-10-05-international-opencraft-chat.md` 记录先前的灰度门禁。

## acceptance
- 国际站 `show()` 关闭时直接显示 Chat 入口、会话侧栏和 OpenCraft；主 Bot 与其他 Bot 都可进入。
- 调用 `show()` 开关不会卸载或隐藏 Chat；国内站行为不变。
- 聚焦测试、前端 check/双站 build、OpenCraft 生成副本和文档影响检查通过；全量 test 的失败须明确记录。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx` 与相邻测试。
- `docs/engineering/domains/site-environment-routing.md`。

## required_context
- 路由器未命中 Pack；依照仓库入口在前端 Chat 路径做有界精确搜索。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@b2a4d7ae0` | 前端门禁 | 确定 check/test/build 和 OpenCraft 副本检查 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@b2a4d7ae0` | 前端邻接 | 核对相邻测试和旧 OpenSpec |
| `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md@b2a4d7ae0` | 历史约束 | 识别旧 AgentChat 规格已过时 |
| `frontend/src/pages/marketing/agent-settings-page.tsx@b2a4d7ae0` | 当前实现 | 定位 `show()` 与 Chat 的唯一绑定 |
| `frontend/src/pages/marketing/__tests__/agent-onboarding-global.test.tsx@b2a4d7ae0` | 相邻测试 | 覆盖默认显示和 `show()` 切换 |

## evidence
- `validate_context.py --route "remove international OpenCraft Chat show() gate and make Chat public by default"` 未命中 Pack；随后仅搜索前端 Chat、相邻测试、正式设计和旧 OpenSpec。
- MR !5000 已合并，当前分支从 `origin/master@b2a4d7ae0` 创建。
- 国际站 Chat 与侧栏聚焦测试 55/55 通过；`pnpm check` 为 166 个当前基线内诊断、0 个新增；`pnpm build:global`（623/623 页）、`pnpm build:cn`（106/106 页）均通过。
- OpenCraft 生成副本 130 个文件无漂移；文档链接检查无错误、断链或警告。
- 全量 `pnpm test` 出现多组与本次路径无关的失败（模型配置、续费导航等）以及多个 Vitest worker 的 Node 堆 OOM，确认无法完成后中止；相关聚焦测试单独通过。

## risks
- 真实国际站账号下的发送和会话行为仍需上线前验证；本轮仅改变入口可见性。

## validation
- 聚焦测试、`pnpm check`、双站构建、OpenCraft 副本和文档链接检查通过；全量 `pnpm test` 未通过，原因见 evidence。

## decisions
- 将 Chat 启用状态固定为公开，保留现有 Chat 入口与内嵌工作台路径；其他 `show()` 工具继续受原开关控制。

## scan_scope
- `frontend/src/pages/marketing/`、`docs/engineering/domains/`、相关 OpenSpec。

## scan_output
- `rg` 定位 `openCraftChatEnabled`、`showHiddenAgentTools`、侧栏与内嵌工作台调用，以及两份相邻测试。

## handoff
- 代码与前端聚焦门禁已验证，待文档影响检查后通过 MR 交付；不合并或发布，真实国际站账号交互待验证。
