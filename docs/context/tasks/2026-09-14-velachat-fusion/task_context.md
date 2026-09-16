---
id: velachat-mono2-fusion-2026-09-14
type: task
scope: 将 Velachat backend、Agent Chat Client 和 Human IM Web 能力迁入 mono2 与 OpenCraft。
triggers: ["velachat fusion", "vela-computer migration", "lightvela collaboration"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - collaboration/platform/v1/model-contract.yaml
  - collaboration/platform/v1/openapi.yaml
  - vela-computer/README.md
  - shared/vela-chat-client-core/README.md
  - opencraft/docs/platform-architecture.md
  - opencraft/design/lightvela-collaboration-workspace.md
status: active
reviewed_at: 2026-09-14
review_due: 2026-12-14
revision: 0.2.0
precedence: task
derived: false
---

## goal

以源码忠实迁移建立 mono2 内唯一可写真源，并让 OpenCraft 以 first-party Extension
消费 collaboration 后台和腾讯云 IM Web 数据面。

## repository_landing

- canonical repository：`git.woa.com/wisp/mono2.git`
- local canonical checkout：`/Users/skipzhang/mono2`
- integration worktree：`/Users/skipzhang/.codex/worktrees/mono2-velachat-fusion-current`
- integration branch：`feat/velachat-fusion`
- pre-current-base backup branch：`backup/velachat-fusion-pre-current-base`
- OpenCraft WIP snapshot base：`dc133f3`
- excluded checkout：`/Users/skipzhang/code/mono2-clean4`，其 HEAD 不含 OpenCraft 且当前存在
  unmerged index entries；不得把本次融合双写或直接覆盖到该工作区。

## non_goals

- 不发布，不操作生产，不建立 cloudagent 依赖。
- 不在目标架构中保留独立 Human 登录和外部 Computer 纳管。

## requirement_ids / requirement_refs / requirement_excerpt

- FUSION-01：Human 只使用 LightVela 账户。
- FUSION-02：Computer 能力代码保留，但在可信加入链路接通前默认不呈现；不开放外部 Computer 加入。
- FUSION-03：Agent 侧代码进入 mono2 独立 `vela-computer/`。
- FUSION-04：后台保持 mono 服务；前端能力作为 OpenCraft first-party Extension。
- FUSION-05：优先复制现有实现，再按需求修改，不做相似重写。
- FUSION-06：Collaboration 复用现有普通数据库服务，在其中使用独立逻辑 database/schema、
  数据库账号和 DSN；不新增数据库实例或数据库基础设施。
- requirement_refs：当前用户会话；外部 TAPD/Issue 为 unknown。

## interface_refs / data_structure_refs

- `collaboration/platform/v1/openapi.yaml`
- `shared/vela-chat-client-core/src/messaging/port.ts`
- `opencraft/packages/extension-contract/src/index.ts`
- LightVela Account session 与 `service-gateway` verified identity boundary。

## history_context

- current_design_refs：`opencraft/docs/platform-architecture.md`、
  `opencraft/docs/plugin-architecture.md`。
- relevant_evolution：Velachat 已将 backend/agent/web 收敛为一个仓库；本次继续迁入 mono2。
- superseded_refs：外部 Computer Enrollment/TAT Host 设计只用于识别待裁剪代码。

## acceptance

- 见 `.omx/plans/velachat-fusion/task_plan.md`。

## affected_paths

- `collaboration/`
- `vela-computer/`
- `shared/vela-chat-client-core/`
- `opencraft/plugins/lightvela-collaboration/`

## required_context

- `agent-gateway-runtime`
- OpenCraft platform/plugin architecture
- chatserver strict contract and migration constraints

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@cb1df4fc1` | mono2 边界 | worktree、真源和验证要求 |
| `docs/context/domains/agent-gateway-runtime.md@cb1df4fc1` | Agent 运行域 | 避免错误复用 cloudagent |
| `opencraft/AGENTS.md@cb1df4fc1` | OpenCraft 边界 | Trusted Extension 与门禁 |
| `opencraft/docs/platform-architecture.md@cb1df4fc1` | 状态所有权 | Account、View、Host 生命周期 |
| `opencraft/docs/plugin-architecture.md@cb1df4fc1` | Extension contract | View/Navigation/renderer 贡献 |
| `/Users/skipzhang/code/velachat/AGENTS.md@c0f8fa280` | 原实现边界 | Agent/Web 源码归属与测试 |
| `/Users/skipzhang/code/chatserver/AGENTS.md@workspace` | 后台严格契约 | OpenAPI/模型/Migration 先行 |
| `docs/context/project/upstream-subtrees.md@workspace` | 一次性迁移谱系 | 确认 OpenCraft mono2 唯一写入真源 |
| `docs/context/project/services/collaboration.md@workspace` | Collaboration 服务路由 | 确认后台与 IM/Computer 边界 |
| `opencraft/MONO2_MIGRATION.md@workspace` | OpenCraft 导入契约 | 排除旧 checkout 双写 |

## evidence

- `go test ./collaboration/...`：1101 tests passed；`go vet ./collaboration/...` passed。
- `go test -p 1 ./vela-computer/...`：974 tests passed；`go vet ./vela-computer/...` passed。
- shared client-core：77 tests passed；typecheck passed。
- OpenCraft：130 Extension tests + 56 Collaboration plugin tests passed；全 workspace typecheck、
  platform boundaries、LightVela Web build 与 product assertion passed。
- 文档系统：27/27 service entries，专项 8 tests passed；完整 Context suite 的 4 个失败均为
  本任务开始前已有的仓库治理问题。
- Phase 9：LightVela Platform account owner、Extension resource history、单一 Collaboration
  Workspace、统一 IM Chat + Members 和 Member→私聊 Group 已通过 TDD、全 OpenCraft typecheck/
  extension/boundary/build，以及 1440/390px mock-harness 浏览器 QA。
- current-base integration：主工作区 OpenCraft WIP 已在独立 snapshot commit `dc133f3` 固化；
  11 个三方冲突按 account/environment/navigation 所有权收敛。`npm run gate` 单次连续通过；
  Collaboration 1115 tests、vela-computer 974 tests、client-core 77 tests，两个 Go module vet、
  OpenAPI/Migration/generated/secret 门禁和全新 SQLite migrate/status/verify 均通过。
- 最终落点核验：`git worktree list` 显示 `feat/velachat-fusion` 属于
  `/Users/skipzhang/mono2/.git`；canonical HEAD 含 `opencraft/`，clean4 HEAD 不含该目录且有
  unmerged entries。

## risks

- 见 `.omx/plans/velachat-fusion/task_plan.md`。

## validation

- Go：迁入前后聚焦 `go test ./...`。
- shared TypeScript：build、typecheck、tests。
- OpenCraft：插件聚焦测试、相关 typecheck，最终 `npm run gate`。
- mono2：change-impact 与文档 context 校验。

## decisions

- 新增目录是独立真源；不使用 `cloudagent/`。
- Web IM 连接为 Extension activation/service 生命周期，不属于 React View。
- 腾讯 IM 群聊/私聊是一套 Chat；与 Codex Thread/Turn/Agent Activity ChatUI 泾渭分明。
- 完整前端收敛为一个 resource URI 驱动的 Collaboration Workspace View。
- IM Chat 与 Members 合并为一个产品区；Tasks/Reminders 暂不进入插件。
- LightVela 用户实例是 `Computer(kind=lightvela_instance)`；collaboration 拥有产品生命周期，
  CTL 只负责底层实例执行和 observed state。
- 一个 Computer 只能归属一个 Server；一个 Server 可以拥有多个 Computers。
- 创建 Computer 时只能选择当前 LightVela 账户下已有实例，并创建
  `Computer(kind=lightvela_instance)`；Computer 页面不购买或新建 CTL 实例。
- Computer 是显式 capability，默认关闭；未注入可信 InstanceDirectory 时 backend route 与 UI
  均不启用，也不读取账户实例目录。
- Collaboration 数据库复用现有普通 DB 服务，但使用独立逻辑库/schema 和独立 DSN；不与
  CTL、user-auth 混表，不新增 DB 实例。
- OpenCraft、Collaboration、`vela-computer` 和共享 client-core 的最终落点统一为 mono2；
  `mono2-clean4` 不再作为本任务目标仓库。

## scan_scope

- Velachat backend/agent/web 与 mono2 OpenCraft Extension 边界。

## scan_output

- 只记录在同目录 findings/progress，不生成 Graphify。

## handoff

- 融合纵切可审查：mono2 新服务目录、共享 LightVela Human account、后台 JIT actor、单一
  Collaboration Workspace 与腾讯云 IM Web transport 已接通；Computer capability 默认隐藏。
- 正式候选位于 `/Users/skipzhang/.codex/worktrees/mono2-velachat-fusion-current` 的
  `feat/velachat-fusion`；已形成五个本地 integration commits：`a891f96`（shared）、
  `7046748`（collaboration）、`3f0bc43`（vela-computer）、`a587910`（OpenCraft）和当前 Context
  commit。尚未 push、创建 MR、发布或修改 GitOps。
- 后续按 `.omx/plans/velachat-fusion/task_plan.md#remaining` 继续完整 UI 和旧外壳裁剪；
  本任务未发布或修改 GitOps。
- Computer `kind=lightvela_instance` 的 v5 contract、migration、attach/list 持久化已实现；可信
  control-plane InstanceDirectory、CTL lifecycle adapter、IM MessageThread 与精确 instance
  Terminal 尚未实现，不能视为端到端可用。
