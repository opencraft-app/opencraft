## goal
总览页点击 Bot 卡片时打开该 Bot 的新对话，并让资料编辑弹窗标题与“修改资料”入口一致。

## non_goals
- 不改 Bot 创建、删除、资料保存或站点发布流程。

## requirement_ids / requirement_refs / requirement_excerpt
- 本次用户请求与两张总览页截图：卡片点击进入该 Bot 新建对话；菜单“修改资料”打开的弹窗标题统一为“修改资料”，覆盖现有语言。

## interface_refs / data_structure_refs
- `AgentFleetOverview` 的卡片回调；`getAgentBotSectionHref` 的 `bot` 查询参数；`pendingNewChatSessionBotId` 与聊天组件会话命令。
- 继续由菜单控制资料弹窗，切换 Bot 时不得调用上一个 Bot 的会话命令。

## history_context
- current_design_refs: `frontend/openspec/specs/bot.md`（历史工作台）；当前总览与会话行为以 `agent-fleet-overview.tsx`、`agent-settings-page.tsx` 为准。
- relevant_evolution: 最新 `master` 已有总览 Bot 卡片和侧边栏新建会话意图；复用现有流程。
- superseded_refs: 无。

## acceptance
- 点击任意可用 Bot 卡片进入带正确 `bot` 参数的聊天页并启动新会话，不弹资料编辑框。
- 卡片菜单仍可修改对应 Bot 资料，弹窗标题和其他资料入口均为“修改资料”；现有语言键覆盖所有已配置语言。
- 创建中、删除中的卡片不可导航；聚焦组件测试及前端门禁通过。

## affected_paths
- `frontend/src/pages/marketing/agent-fleet-overview.tsx`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/agent-overview-panel.tsx`
- 相邻测试。

## required_context
- frontend-product-surface、service-frontend、site-environment-routing。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@e08b0db87` | 服务规则 | 验证门禁与 i18n 约束 |
| `docs/context/project/services/frontend.md@e08b0db87` | 服务上下文 | 确认前端边界 |
| `docs/context/domains/site-environment-routing.md@e08b0db87` | 区域与语言 | 限定国内站行为及翻译方式 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@e08b0db87` | 相邻入口 | 核对 OpenSpec、语言入口与组件测试 |
| `frontend/openspec/specs/bot.md@e08b0db87` | 已归档规格 | 确认旧工作台与当前总览并非同一路由 |
| `frontend/src/i18n/index.ts@e08b0db87` | 翻译入口 | 使用已有“修改资料”键 |

## evidence
- `pnpm check` 通过（0 个新增 TypeScript diagnostics，六种目标语言的字典检查通过）。
- 聚焦组件与路由测试在独立工作区共 82 项通过；同步到 5174 预览工作区后，相关组件测试 73 项通过。
- `pnpm build:cn` 通过；文档校验与 staged change-impact 检查通过。
- Chrome `http://localhost:5174/agents/overview/`：卡片按钮显示“新建对话: bot-1”，点击后进入 `/agents/chat/?bot=<该 Bot ID>`，未打开资料弹窗。该账号 Bot 已暂停，聊天页显示暂停提示，无法实测实际会话创建。
- 全量 `pnpm test` 遇到多处无关失败和 Node 4 GB heap OOM，未完成全套测试。

## risks
- 从其他 Bot 切换时若旧会话命令仍存在，可能创建到旧 Bot；导航前清理命令，原有实例切换 effect 再次清理。本地仅暂停 Bot 可见，需运行中的多 Bot 账号完成实际新会话验证。

## validation
- 前端 `pnpm check`、`pnpm test`、`pnpm build`；相关组件测试；context change-impact 检查。

## decisions
- 复用侧边栏新对话意图，不新建路由或翻译键；owner: 本轮实现。

## scan_scope
- `frontend/src/pages/marketing/` 中总览卡片、共用弹窗及会话导航。

## scan_output
- 本 Task Pack 的路径与测试结果摘要。

## handoff
- 已在本地 5174 国内站预览工作区实现并验证可见导航；未提交、未推送、未发布。
