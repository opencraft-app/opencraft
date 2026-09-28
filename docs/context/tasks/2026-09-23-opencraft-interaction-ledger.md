---
id: opencraft-interaction-ledger
type: task
scope: Host-runtime-owned pending interaction response lifecycle across AppServer reconnects.
triggers: ["Skip reconnect loop", "pending interaction", "server request response"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-23-opencraft-interaction-ledger.md
status: complete
reviewed_at: 2026-09-23
review_due: 2026-12-22
revision: 1.0.0
precedence: task
derived: false
---

## goal
让 Skip/审批/问答响应由 Host-scoped Workbench runtime 持有确认状态：响应只有在 AppServer transport 完成 server-response delivery 后才结束 UI pending；连接结果未知时保留同一 resolution，重连重发同一 server request 时自动对账而不重新弹窗。

## non_goals
- 不改变 Codex 原生 approval、option picker、setup step 或 MCP elicitation payload。
- 不用 React 状态、localStorage 或隐藏弹窗模拟成功。
- 不在本次实现跨应用重启的持久数据库；Ledger 只跨同一 Host runtime 的 transport/client generation。
- 不提交、推送或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户观察：点击弹出选项的 Skip 后提示重连，重连后同一弹窗再次出现。
- 决策：复用 Codex 交互协议映射，响应生命周期按 BB 的稳定身份、resolving、幂等交付与 tombstone 建模。

## interface_refs / data_structure_refs
- `AppServerClient.handleServerRequest`：向 handler 暴露 server-response delivery receipt。
- `AppServerInteractionBroker`：响应验证、pending View 投影与 receipt 消费。
- `AppServerInteractionLedger`：Host runtime 跨连接代次持有 exact response 与 delivered tombstone。
- 不变量：Renderer 点击不是 Host 接纳；同一 request 只能重放同一 response；不同 response 必须冲突。

## history_context
- `current_design_refs`：`opencraft/docs/execution-ownership.md`。
- `relevant_evolution`：当前 Broker 在 `transport.send` 前删除 pending；Codex 使用 Renderer→Main response receipt；BB 使用 Provider request identity、持久 pending/resolving/resolved 与 Host tombstone。
- `superseded_refs`：无。

## acceptance
- server-request handler 可观察 response delivered/failed，而不是在返回 result 时即视为完成。
- transport send 未完成时 UI interaction 保持 submitting/pending。
- send 失败后同一 Host runtime 的新 client 重发相同 request 时自动提交原 resolution，不再次发布 pending UI。
- 同一 request 的重复 response 幂等；不同 response 返回稳定冲突。
- AppServer client、interaction broker、Workbench reconnect 聚焦测试以及相关 typecheck/boundary 通过。

## affected_paths
- `opencraft/packages/appserver-client/src/client.ts`
- `opencraft/packages/composer-appserver/src/interaction-broker.ts`
- `opencraft/packages/workbench-runtime/src/appserver-runtime.ts`
- 相关测试和正式执行所有权文档。

## required_context
- 根 `AGENTS.md` 与 `opencraft/AGENTS.md`。
- `opencraft/docs/platform-architecture.md`、`opencraft/docs/execution-ownership.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库与 Task Pack 边界 | 不提交/发布，更新正式设计 |
| `opencraft/AGENTS.md@working-tree` | Host、Thread、协议 owner | Renderer 不成为响应 authority |
| `opencraft/docs/execution-ownership.md@working-tree` | 生命周期不变量 | 响应确认绑定 Host/连接代次 |
| `ref/codex/shared/handle-setup-codex-step-tool-call-04148.ts@working-tree` | Codex payload/Renderer→Main 映射 | 保留原生 Tool Result |
| `ref/bb/apps/host-daemon/src/interactive-request-registry.ts@working-tree` | BB 去重/tombstone | Ledger identity 与幂等规则 |
| `ref/bb/apps/server/src/services/interactions/pending-interactions.ts@working-tree` | BB resolving/resolved 状态 | 确认后才终结 pending |

## evidence
- Context Router query `opencraft host-owned interaction ledger reconnect skip duplicate popup` 无 Pack 命中，已改用有界精确搜索。
- TDD Red 1：server-request handler 第三参数为 `undefined`，证明没有物理 response delivery receipt。
- TDD Red 2：transport response 被 gate 阻塞时，旧 Broker 仍立即完成 `respond()` 并移除 pending。
- TDD Red 3：跨 client generation 没有 Ledger export；无法保留 exact Skip response。
- TDD Red 4：同 request identity 复用不同 payload 未被拒绝。
- TDD Red 5：第二代连接用新 JSON-RPC id 重发相同 Item 时仍重新发布了 pending UI；Ledger identity 改为优先使用稳定 Item/call ID。
- Green：AppServer Client delivery receipt、Host-scoped Interaction Ledger、Broker delivery gate、跨 generation exact-response replay、request/response fingerprint 冲突与 5 分钟 TTL 均由聚焦测试覆盖。
- `npm run test:appserver`、`npm run test:chat`、完整 `npm run typecheck`、`npm run check:boundaries` 通过。
- `npm run build:web` 通过；仅保留既有 Vite 大 chunk、动态/静态 import 与运行时 URL 警告。

## risks
- server-request handler contract 变化可能影响浏览器、Connector 与 Lab handler；通过可选第三参数保持调用兼容。
- 自动重放只能匹配稳定 request identity 与完全相同 response；Ledger 有界、TTL 到期后不猜测。
- receipt 只证明 transport delivery，不声称 Provider 已执行；Provider 重发同一 request 时用 exact response 幂等对账。

## validation
- `npm exec -- tsx --test tests/appserver-client.test.ts tests/chat-appserver-command.test.ts tests/chat-workbench-reconnect-policy.test.ts`
- 受影响 workspace typecheck。
- `npm run check:boundaries`。
- exact change-impact、documentation validation、`git diff --check`。

## decisions
- OpenCraft 保留 Codex 原生 response mapping；不复制 BB 的中心 Server/DB 拓扑。
- Server 仍持有 pending/resolved 真相；Ledger 归 Client 的 Host-scoped Workbench runtime，只持有 delivery resolution，跨 client generation 生存；Broker 只是当前 transport adapter。
- 采用 delivery receipt + exact-response replay，不以“点击完成”删除 interaction。

## scan_scope
- `opencraft/packages/appserver-client`、`composer-appserver`、`workbench-runtime` 与聚焦测试。

## scan_output
- 无外部扫描产物。

## handoff
- 源码、设计、聚焦/全量相关测试、完整 typecheck、边界与 Web production build 已完成。未提交、推送、打包或发布；真实外部 Provider 的断线窗口仍需在更新后的桌面运行时回归。
