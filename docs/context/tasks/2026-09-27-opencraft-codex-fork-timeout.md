## goal
消除普通 Codex Fork 被 Workbench 通用 30 秒超时误判为失败的问题，并保留明确的未知结果边界。

## non_goals
- 不改变普通 Fork 的 `excludeTurns`、`lastTurnId` 或其他 AppServer 参数语义。
- 不自动重试非幂等 Fork，不操作生产或替换当前预览。

## requirement_ids / requirement_refs / requirement_excerpt
- `user-2026-09-27-fork-timeout`: 用户复现 `AppServer request thread/fork timed out after 30000 ms`，要求参考 bb、再以 `ref/codex` 为真信源严格整改。

## interface_refs / data_structure_refs
- `AppServerClient.request(..., { timeoutMs })`；`ThreadForkParams`；`WorkbenchRuntime.resources.threads.fork`。
- 普通 Fork 的结果只在唯一请求回执后认领；超时和断线不能视为确定失败，不能盲目重试。

## history_context
- `current_design_refs`: `opencraft/docs/platform-architecture.md` Thread 生命周期。
- `relevant_evolution`: `docs/context/tasks/2026-09-25-opencraft-codex-fork-capability.md` 的持久 Fork 与目录投影。
- `superseded_refs`: 无。

## acceptance
- 普通 Fork 超过 Workbench 默认请求超时仍能等待并接收原请求响应；不改变 Fork 参数。
- 断线/拒绝不自动产生第二个 Fork；结果未知与确定拒绝的用户反馈区分。
- 聚焦协议/运行时/导航测试及相关类型检查通过。

## affected_paths
- `opencraft/packages/workbench-runtime/src/appserver-runtime.ts`、`opencraft/apps/workbench-web/src/`、`opencraft/tests/`、`opencraft/docs/platform-architecture.md`。

## required_context
- `agent-gateway-runtime`、`site-environment-routing`、`upstream-subtrees`、`service-opencraft`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/agent-gateway-runtime.md@working-tree` | 执行边界 | OpenCraft 与上游责任 |
| `docs/context/domains/site-environment-routing.md@working-tree` | Router 结果 | 确认无站点变更 |
| `docs/context/project/upstream-subtrees.md@working-tree` | 参考源边界 | `ref/codex` 只读 |
| `docs/context/project/services/opencraft.md@working-tree` | 服务边界 | Workbench/Host 定位 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree`、`references/verification.md@working-tree` | 维护纪律 | 异步未知结果与验收 |
| `ref/codex/conversations/fork-conversation-04177.ts@working-tree`、`ref/codex/service/app-server-request-client-module-03167.ts@working-tree` | 参考行为 | 普通 Fork 不传 excludeTurns、请求默认无限时 |

## evidence
- Workbench 客户端默认 30 秒，`threads.fork` 未覆盖，导致大历史 Fork 超时。
- `ref/codex` 普通 Fork 不设置 `excludeTurns`，请求客户端未显式超时时用 0。
- Codex 空白持久 Fork 在首轮前不进入原生列表，刷新不是精确对账。
- 运行时聚焦测试使默认期限缩短至 20 毫秒、延迟 Fork 响应 45 毫秒，原请求仍成功；两个相同并发意图只生成一条 RPC。

## risks
- WebSocket/Host 断线仍可能产生已创建但未收到响应的子分支；无请求幂等键时自动重发会重复创建。

## validation
- `node node_modules/tsx/dist/cli.mjs --test tests/chat-workbench-draft.test.ts tests/thread-fork-navigation.test.ts`：31/31 通过。
- `node node_modules/tsx/dist/cli.mjs --test tests/appserver-client.test.ts tests/chat-workbench-reconnect-policy.test.ts tests/thread-fork-navigation.test.ts`：21/21 通过。
- `tsc --noEmit`：`packages/workbench-runtime`、`apps/workbench-web` 通过。
- `scripts/generate-typography.mjs --check`、`scripts/check-platform-boundaries.mjs` 与 `git diff --check` 通过。
- 当前环境无 `npm`/`npx` 命令；未运行完整 `npm run gate`，也未替换正在运行的预览。

## decisions
- 在 Workbench Fork 操作上设置 `timeoutMs: 0`，不改变其它请求的 30 秒保护。
- 相同参数的并发 durable Fork 共用一次请求；真实 RPC 拒绝仍报告错误，传输丢失则报告结果未知，不自动重试。
- 不把本次警示文案称为精确对账。跨 Host/进程的 exactly-once 需要可持久化的请求身份与原生结果认领协议。

## scan_scope
- Workbench Fork 路径、AppServer 客户端、Codex 参考实现与相邻测试。

## scan_output
- 精确搜索找到 `appserver-runtime.ts:1325` 与 `client.ts:205/284`。

## handoff
- 源码和聚焦验证完成；未部署。断线后原生 Fork 已创建但响应丢失的场景依旧无法精确认领，只能禁止自动重试并提示未知结果。
