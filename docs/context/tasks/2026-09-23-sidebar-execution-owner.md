## goal
建立 Client / Hub / Server 所有权模型，并让 Sidebar 来源图标表示稳定 Server provenance，而不是 Host、Renderer、路由或状态。

## non_goals
- 本轮不直接升级 App Host version-1 wire protocol。
- 不把 Hub 路由、Host placement 或连接健康编码进 Server ID。
- 不改 Thread 历史格式或执行引擎私有持久化。

## requirement_ids / requirement_refs / requirement_excerpt
- USER-2026-09-23-CLIENT-HUB-SERVER：Client 与 Server 通过多租户 Hub 多对多交互并允许 Hub 级联；Renderer 只是呈现方式，Host 只是部署载体。
- USER-2026-09-23-SERVER-ORIGIN：Sidebar 地球区分会话/Activity 来自哪个 Server，且与状态正交。

## interface_refs / data_structure_refs
- `ClientHubAttachment = { clientId, incarnation, hubId, tenantId, leaseId }`
- `HubServerRoute = { hubId, tenantId, serverId, routeId, epoch }`
- `ServerHubAttachment = { serverId, serverIncarnation, hubId, tenantId, leaseId }`
- `ThreadServerOrigin = { serverId, label }`；`ServerRouteLocality = local | remote` 与来源身份正交。
- `legacyDirectServerProjectionFromHost()` 是现有一 Host profile 对一直连 Server 的唯一兼容投影。

## history_context
- 先前将 `executionOwner.hostId` 直接用于来源图标；用户澄清后该模型已废弃，因为 Host 与 Server、Renderer 与 Client、直连与 Hub route 均不是同一身份。
- 当前 App Host v1 的 `rendererId` 与 `hostId` 是历史 wire 命名；新领域代码不得据此推导所有权。

## acceptance
- 共享 contract 能表达 Client/Server 对 Hub 的独立 attachment，同一 Server 可经不同 Hub route 到达而不改变 Server ID。
- Sidebar 颜色仅由 `serverId` 派生；本机 Server 隐藏，远程 Server 显示；状态槽位独立。
- Host ID 仅用于当前兼容连接、菜单和执行定位；Server 来源不由 Feature 自行从 Host 猜测。
- 文档定义 Hub 多租户、级联防环、route epoch、tenant 隔离、幂等执行和断路不删状态等不变量。

## affected_paths
- `opencraft/packages/workbench-runtime/src/client-hub-server.ts`
- `opencraft/apps/workbench-web/src/runtime/appserver-runtime-context.tsx`
- `opencraft/apps/workbench-web/src/components/{sidebar,sidebar-activity-item}.tsx`
- `opencraft/docs/{platform-architecture,execution-ownership,workbench-design-language}.md`
- `opencraft/design/invariants.md`

## required_context
- 根/OpenCraft Agent 入口；platform architecture；execution ownership；workbench design language；trace skill。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md@working-tree` | OpenCraft 所有权/验收 | 实施边界 |
| `opencraft/docs/execution-ownership.md@working-tree` | 现有 Thread/Host owner | 纠正顶层 owner |
| `opencraft/docs/platform-architecture.md@working-tree` | 当前 HostRuntime 拓扑 | 标出 v1 兼容缝 |
| `opencraft/packages/app-host-protocol/src/index.ts@working-tree` | rendererId/hostId wire | 区分历史 wire 与领域身份 |
| `opencraft/packages/app-host-server/src/index.ts@working-tree` | logical routing/lease | 确认现有 Hub-shaped boundary |

## risks
- 当前协议尚未携带显式 Hub/tenant/Server coordinates；不能假装已完成 wire migration。
- 直连兼容投影仍以 hostId 初始化 serverId；必须集中在一个函数，后续协议升级后删除。

## validation
- workbench-runtime/web typecheck；Client/Hub/Server 与 Sidebar 聚焦测试；i18n/boundaries；真实 Electron Sidebar smoke。

## decisions
- 顶层协议对象固定为 Client / Hub / Server；Renderer 与 Host 降为呈现和部署事实。
- Server 拥有 Thread/历史/执行状态；Hub 拥有多租户 attachment、route、subscription 与 lease。
- 同一 Server 换 Hub route 不换来源颜色；route status 与 Thread status 均使用独立语义。

## scan_scope / scan_output
- Context Router 未匹配；有界搜索 App Host protocol/client/server、HostRuntimeDescriptor、MultiHost catalog 与 Sidebar Activity。

## evidence
- `client-hub-server.test.ts` 与 `sidebar-activity.test.ts` 共 8 项通过：多对多 attachment、Hub tenant 映射/防环、跨 Hub route 的稳定 Server ID、legacy direct seam、Sidebar 来源/状态正交。
- `@opencraft/workbench-runtime`、`@opencraft/workbench-web`、`@opencraft/app-host-protocol` typecheck 通过。
- Web production build、`check:i18n`、`check:boundaries`、`git diff --check` 与仓库 documentation validation 通过。
- 独立 Sidebar smoke 因当前 checkout 未安装 Playwright 而未执行；未将旧 Host smoke 证据冒充本轮 Server-origin 证据。

## handoff
- 未提交、推送、发布或替换已安装应用。
