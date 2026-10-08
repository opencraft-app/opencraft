## goal
主站 OpenCraft 嵌入式 Chat 在 Agent 正在回复时，发送新消息默认进入下一轮队列。

## non_goals
- 不改变独立 OpenCraft Workbench、临时 Side Chat 或空闲时的新消息发送。
- 不提交、推送、发布或变更运行中的生产服务。

## requirement_ids / requirement_refs / requirement_excerpt
- 本次用户请求：主站 Chat 的 embedded 模式从直接 steer 改回发送后先 queue。

## interface_refs / data_structure_refs
- `opencraft/apps/workbench-web/src/app.tsx` 的 `CodexComposer.defaultFollowUpAction`。
- `opencraft/packages/composer-core/src/submission.ts` 的 queue/steer 行为与 Host 方法准入。
- `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/protocol.ts` 的 `thread/queue/add`。

## history_context
- current_design_refs: `opencraft/docs/chat-ui-architecture.md`、`docs/engineering/domains/agent-gateway-runtime.md`。
- relevant_evolution: 主站 `frontend/src/pages/marketing/agent-settings-page.tsx` 已通过 `AgentChatMigrationSurface` 使用 OpenCraft embedded 元素；旧 AgentChat SDK 不是当前主站 Chat 入口。10 月 5 日提交 `1a53b96c3` 前，主会话未传跟进偏好，Composer 自身默认 queue；该提交开始传入安装级 steer 默认值。
- superseded_refs: `frontend/src/pages/marketing/agent-chat-panel.tsx` 仅供迁移历史定位。

## acceptance
- 运行中的主站 embedded 会话发送普通消息时选择 queue；空闲时仍正常发送。
- 独立 Workbench 继续读取既有安装级跟进偏好；Host 不支持 queue 时仍遵守方法准入。
- 通过 OpenCraft 聚焦测试、Web workspace 类型检查以及受影响的文档影响门禁。

## affected_paths
- `opencraft/apps/workbench-web/src/app.tsx`
- `opencraft/tests/chat-composer-queue.test.tsx`
- `opencraft/tests/chat-runtime.test.ts`
- `opencraft/docs/chat-ui-architecture.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- frontend-product-surface、service-frontend、site-environment-routing；agent-gateway-runtime、upstream-subtrees、service-opencraft。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md` | 主站服务边界 | 确认嵌入式接入归属 |
| `docs/context/domains/site-environment-routing.md` | 双站边界 | 限定主站行为 |
| `frontend/AGENTS.md` | 前端规则 | 选择前端验证 |
| `docs/context/domains/agent-gateway-runtime.md` | Chat Runtime 路由 | 确认 OpenCraft owner |
| `docs/context/project/upstream-subtrees.md` | subtree 边界 | 确认 mono2 唯一写入源 |
| `docs/context/project/services/opencraft.md` | OpenCraft 服务入口 | 选择服务验证 |
| `opencraft/AGENTS.md` | OpenCraft 局部规则 | 遵守改动与交付边界 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 前端邻接 | 检查 embedded 实现和相邻测试 |
| `opencraft/docs/chat-ui-architecture.md` | Composer 正式设计 | 确定 queue/steer 语义 |

## evidence
- 源码确认：主站 `openCraftChatEnabled = true`，`AgentChatMigrationSurface` 加载 `opencraft-embedded-workbench`；`App` 将跟进偏好传给 `CodexComposer`。
- `npx tsx --test` 的 Composer、Hermes Queue 等聚焦测试通过（41/41）；`npm run test:embedded-ci` 通过（176/176）。
- `npm run typecheck --workspace @opencraft/workbench-web`、`npm run check:boundaries`、`npm run build:embedded-workbench:release` 均通过。
- `validate_documentation.py` 无错误，`validate_change_impact.py --staged` 通过。`smoke-console-embedded.mjs` 的隔离浏览器场景加载到 embedded 元素后，在等待旧版连接错误文案「请检查 AI 伙伴状态后重试」时超时。进一步检查显示模拟账号的会话加载失败，页面回退到 legacy；该 smoke 未能作为本轮 queue 行为验收。
- 用户截图暴露了预览路由误判：Chrome 的 Whistle 已选规则仍把 `lightvela.com` 指向 5175，之前看到的页面来自另一个工作树。现已仅把该规则的国内站 HTTP/HMR 端口改为 5174，并通过 Whistle `rules/select` 重新解析规则；国际站设置保持原样。Chrome 原截图标签重新加载后，`/__opencraft/embedded-workbench.js?queue-preview=20261008-2` 与本地生成的前端 chunk 均已出现，登录态会话和 embedded 输入框可见。运行中发送消息后的真实 Hermes 投递仍待人工验收。
- `chat-runtime` 聚焦测试补充断言：queue 在提交中及 Host 确认后均只位于 `queuedSubmissions`，不会出现在对话时间线；相关 46 项测试通过。
- 后续复查时，5174 本地 HTTP 及当前嵌入入口资源仍正常；但新开的 Chrome 标签加载了 `__releases/` 生产资源。Whistle 国内站规则被改回 5175 后已恢复 5174，Chrome 当前仍未通过该映射访问本地预览；登录态视觉验收需要用户重新启用 Chrome 代理。

## risks
- 曾验证真实登录态的本地 Chat 呈现，但当前 Chrome 已回到生产资源，不能据此确认此刻的登录态预览。未由 Agent 触发真实 Hermes Turn；通过 Composer、Runtime 与 Host queue contract 测试缩小风险。尚未验证真实运行中 Turn 的可见队列。生产仍需独立发布与回归。

## validation
- `opencraft` 聚焦 queue/Composer 测试。
- `npm run typecheck --workspace @opencraft/workbench-web`。
- 仓库文档与 staged change-impact 检查。

## decisions
- 只在 embedded `App` 选择 queue，不改安装级默认偏好，避免影响独立 Workbench。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/src/pages/marketing/opencraft-embedded-workbench.tsx`、`opencraft/apps/workbench-web/src`、`opencraft/packages/composer-core/src`。

## scan_output
- 有界 `rg` 结果已归纳在 evidence；未生成独立扫描文件。

## handoff
- 本地源码变更和验证完成后交接；不包含 commit、push、MR 或发布。
