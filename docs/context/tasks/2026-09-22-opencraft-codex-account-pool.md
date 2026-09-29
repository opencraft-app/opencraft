---
id: opencraft-codex-account-pool
type: task
scope: OpenCraft Host-side Codex multi-account routing foundation.
triggers: ["Codex account pool", "multi-account Codex"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-22-opencraft-codex-account-pool.md
status: active
reviewed_at: 2026-09-22
review_due: 2026-12-21
revision: 1.0.0
precedence: task
derived: false
---

## goal
在 OpenCraft 正确的 Host/provider 边界复刻 bb 的 Codex 多账户行为：Codex AppServer 只连接一个虚拟 Provider，Host 侧账户池负责凭据隔离、Thread 亲和、额度观测与受控切换。

## non_goals
- 不把 Account 建模为 Host、Engine、Thread 或模型。
- 不把真实 OAuth Token 传给 Renderer、写入进程参数或改写用户的 `~/.codex/auth.json`。
- 不复制 bb 的产品 UI、Plugin API 或数据库实现细节。
- 本任务不包含发布、GitOps、生产环境或真实付费推理。

## requirement_ids / requirement_refs / requirement_excerpt
- `user-2026-09-22-codex-account-pool`：用户要求复刻 bb 中 Codex AppServer 经代理间接支撑多账户的行为。
- 参考实现固定为 `ref/bb@62fe3bc46bd1d935b71482b62a1e0887ffb83487`。

## interface_refs / data_structure_refs
- `opencraft/packages/appserver-protocol/src/methods.ts`
- `opencraft/apps/opencraft-daemon/src/main.ts`
- `opencraft/apps/local-agent-host/src/main.ts`
- `ref/bb/plugins/account-pool/src/{server,hub,store,codex-adapter,request-body}.ts`
- 不变量：真实账号凭据只由 Host 侧 Secret Store 和上游代理读取；Thread affinity 按 `(provider, hostId, providerThreadId)` 隔离；AppServer 仅获得虚拟 Provider 地址与 Host-scoped hub token。

## history_context
- `current_design_refs`：`opencraft/docs/platform-architecture.md`、`opencraft/docs/execution-ownership.md`、`opencraft/docs/architecture/product-identity.md`。
- `relevant_evolution`：当前生产路径以 DSH/Hermes adapter 实现 AppServer 语义；Codex AppServer 真实进程目前已在 Side Chat smoke 中验证。
- `superseded_refs`：无。

## acceptance
- 明确且测试 Host-side Account Pool 的账户选择、Thread 亲和、额度切换、OAuth 失败和 secret 文件权限。
- Codex AppServer 启动只获得虚拟 Provider 配置和 Host token，不获得真实账户 Token。
- 同一 Thread 在账号仍可用时保持亲和；新 Thread 与失效/耗尽账号按策略选择后继账号。
- 不调用真实外部模型；使用本地合成上游验证请求头和切换行为。

## affected_paths
- `opencraft/packages/account-pool-host/`
- `opencraft/tests/account-pool-host.test.ts`
- `opencraft/scripts/smoke-codex-account-pool.ts`
- `opencraft/package.json`、`opencraft/package-lock.json`
- `opencraft/docs/platform-architecture.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- 根 `AGENTS.md`
- `opencraft/AGENTS.md`
- `opencraft/docs/platform-architecture.md`
- `opencraft/docs/execution-ownership.md`
- `opencraft/docs/architecture/product-identity.md`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库边界与 Task Pack 要求 | 限定变更、验证和发布权限 |
| `opencraft/AGENTS.md@working-tree` | OpenCraft 局部所有权 | 确认凭据、Host、Engine 分离及验证入口 |
| `ref/bb/AGENTS.md@62fe3bc46` | 参考仓库责任边界 | 区分 server policy 与 host-local primitive |
| `opencraft/docs/platform-architecture.md@working-tree` | AppServer、Host、凭据和包所有权 | Account Pool 放在 Host/provider 层，不进入 Renderer |
| `opencraft/docs/execution-ownership.md@working-tree` | Thread、Engine、执行权不变量 | Account 不能成为 Thread 或 Engine 身份 |
| `opencraft/docs/architecture/product-identity.md@working-tree` | 数据目录与 cwd 权威 | 存储目录必须由上层注入，不推断 home/cwd |
| `docs/engineering/domains/agent-gateway-runtime.md@working-tree` | Host/provider 路由正式领域设计 | 同步 Account Pool 所有权、不重放与未接产品边界 |

## evidence
- `python3 .agents/context/scripts/validate_context.py --route 'opencraft Codex appserver account pool multiple accounts affinity quota proxy implementation'`：无现成 pack，按要求执行有界精确搜索。
- `rg` 已确认真实 Codex AppServer 仅存在于 `scripts/smoke-side-chat-appserver.ts` 测试入口；当前没有生产 Codex Engine owner。
- 官方 standalone Codex CLI `0.155.1` 已安装到 `/Users/skipzhang/.local/bin/codex`，`codex app-server --help` 与 schema generation help 已验证；未发起推理或修改登录状态。
- `npx tsx --test tests/account-pool-host.test.ts`：12 项通过，覆盖持久亲和、额度/认证切换、短 hold、Host 隔离、父子继承、凭据权限和重复写保护。
- `npm run smoke:codex-account-pool` 等价脚本已实跑通过：真实 Codex AppServer WebSocket，经 Account Pool 到本地合成 Responses，上游 1 次、外部请求 0 次。
- `npm run test:appserver`：189 项通过；`npm run typecheck --workspace @opencraft/account-pool-host` 与 `npm run check:boundaries` 通过。
- 文档校验、显式变更集 change-impact 与 tracked diff whitespace 检查通过；高风险责任面仍要求 `wisp/mono2-maintainers` Owner review。

## risks
- 当前工作树大量未提交改动与目标路径重叠；采用新增模块、逐文件 diff 和聚焦验证降低覆盖风险。
- 若当前没有生产 Codex Engine，直接接线账户池会形成无消费者能力；shape 阶段必须先确认最小可交付切片。
- 账户切换可能破坏服务端会话亲和；必须以 Provider Thread ID 为 affinity，且失败后的自动重试不得重复用户 Turn。

## validation
- 受影响 workspace typecheck。
- Account Pool 聚焦单元测试和本地合成 Responses 上游集成测试。
- `npm run check:boundaries`（若跨包 contract 变化）。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`。

## decisions
- Account Pool 是 Provider credential routing policy，不是 Host、Engine 或 Thread。
- 真实账号 Token 不进入 Codex AppServer；AppServer 只连接 Host-side virtual provider。
- 是否同时交付生产 Codex Engine 接线，取决于 shape 阶段对现有 owner 的确认。

## scan_scope
- `opencraft/apps/opencraft-daemon`
- `opencraft/apps/local-agent-host`
- `opencraft/apps/workbench-electron`
- `opencraft/packages/*runtime*`
- `opencraft/plugins`

## scan_output
- 记录于 FE-AI change 的 `findings.md`。

## handoff
- Host-side Account Pool slice 已实现并验证。生产 `CodexEngineAdapter`、账户 UI、Device Login/真实 refresh 仍是后续任务；本轮未提交、发布或替换应用。
