## goal
让 Codex Host 在 queued steer 获得匹配 Turn 确认后继续接纳后续消息，同时保留结果不明时的持久阻塞与对账保护。

## non_goals
- 不改 Codex AppServer、DSH、生产服务或正在运行的预览。
- 不自动重发投递结果不明的消息。

## requirement_ids / requirement_refs / requirement_excerpt
- 本会话用户确认“理论上是可以解决的是吧？问题是怎么做优雅？”后要求“好的 改起来”。
- 截图中的连续消息曾触发 `An earlier delivery must be reconciled first`，前一条后来成功结算。

## interface_refs / data_structure_refs
- `opencraft/apps/opencraft-daemon/src/codex-host-queue.ts`: SQLite `queued/dispatching/steering/unknown/delivered/discarded`。
- `opencraft/apps/opencraft-daemon/src/codex-engine-adapter.ts`: `thread/queue/steer`、`turn/steer`、按 client message ID 对账。
- 不变量：同 Thread 每次仅有一个物理投递准入操作；确认响应先持久化为 accepted/steering；unknown 不自动重发。

## history_context
- current_design_refs: `opencraft/docs/chat-ui-architecture.md` 的 Host-owned Codex queue 契约。
- relevant_evolution: 现有 Host queue 已将 steer 确认后的消息标为 `steering`，但仍用 `firstUnsettled` 阻止后一条。
- superseded_refs: 无。

## acceptance
- 两条 queued steer 连续发送：第一条已确认但历史未同步时，第二条可发送。
- 第一条投递结果不明时，第二条仍不得自动或手动投递。
- 正常等待不显示人工恢复按钮；对账提示不提供无效的 Resume。
- unknown 存在时禁用后续发送与排序，但保留队列项编辑、删除和未知 claim 的审查入口。

## affected_paths
- `opencraft/apps/opencraft-daemon/src/codex-host-queue.ts`
- `opencraft/apps/opencraft-daemon/src/codex-engine-adapter.ts`
- `opencraft/packages/codex-composer/src/queue-tray.tsx`
- 对应聚焦测试和 `opencraft/docs/chat-ui-architecture.md`

## required_context
- `agent-gateway-runtime`, `service-opencraft`；根与 OpenCraft AGENTS；OpenCraft maintenance skill。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库门禁 | 不发布、先验证 |
| `opencraft/AGENTS.md@working-tree` | 服务边界 | Host/Renderer owner 与验证 |
| `docs/context/domains/agent-gateway-runtime.md@working-tree` | 运行时归属 | 将修改限定 OpenCraft |
| `docs/context/domains/site-environment-routing.md@working-tree` | 路由器 must_read | 不触及站点路由 |
| `docs/context/project/upstream-subtrees.md@working-tree` | 路由器 must_read | ref 只读 |
| `docs/context/project/services/opencraft.md@working-tree` | 服务上下文 | 独立构建与门禁 |
| `docs/context/project/services/ctl.md@working-tree` | 路由器 must_read | 不触及 CTL |
| `docs/context/project/services/frontend.md@working-tree` | 初始路由 must_read | 不触及 frontend |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | 维护规范 | 先所有权再实现 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@working-tree` | 验收 | 聚焦协议/界面测试 |
| `opencraft/docs/platform-architecture.md@working-tree` | 架构 | Host 与 Client 分界 |
| `opencraft/docs/chat-ui-architecture.md@working-tree` | 当前契约 | 更新 accepted 与 unknown 语义 |

## evidence
- 只读队列记录：2026-09-28 07:21:05 的第一条于 07:21:17 delivered；07:21:09 后一条当时被阻塞。
- 合成 AppServer 延迟 steer 历史物化，两个确认仍可依序接纳；历史物化后都结算。
- unknown 队列头阻止后一条 steer；未知 Turn 目标按所有 Turn 历史匹配 client message ID。

## risks
- 错把 unknown 当 accepted 会重复投递；保留 unknown 阻塞和历史对账。
- 旧 UI pause reason 可能误导；将可恢复操作与错误原因分开。

## validation
- Codex Host queue、adapter、Composer queue 聚焦测试；相关 typecheck/lint、边界检查。
- 最新聚焦测试 34/34 通过；后续补充的 Composer 单独测试 7/7 通过。
- `npm run test:appserver` 240/240、`npm run test:chat` 437/437、daemon 与 composer 两个 workspace typecheck、`npm run check:boundaries` 通过。
- 本轮没有重启或替换预览；正在运行的进程仍是旧构建，未作真实手机界面验收。

## decisions
- 已确认 steer 不再占用投递队列头，但保留 `steering` 历史对账投影；不改变线协议。

## scan_scope
- 上述 OpenCraft Host、Composer 与邻接测试。

## scan_output
- bounded `rg` 搜索摘要见本次终端记录。

## handoff
- 源码与测试已完成；没有重启预览。后续若要在手机上验收，需另行构建并替换隔离预览。
