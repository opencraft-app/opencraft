---
id: opencraft-codex-production
type: task
scope: Production local Codex Engine, account UI, Device Login and OAuth refresh in OpenCraft Electron.
triggers: ["CodexEngineAdapter", "Codex accounts", "Codex Device Login"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-22-opencraft-codex-production.md
status: active
reviewed_at: 2026-09-22
review_due: 2026-12-21
revision: 1.1.0
precedence: task
derived: false
---

## goal
让 OpenCraft 本机桌面正式支持 Codex Engine：Daemon 真实拥有 Codex AppServer 生命周期并接入已实现的 Account Pool，同时提供账户管理 UI、OpenAI Device Login 与真实 OAuth refresh。

## non_goals
- 不改变 LightVela Web 登录、Hermes Profile、DSH 模型凭据或云实例身份。
- 不调用真实付费推理，不替用户添加真实账号作为自动化验收。
- 不提交、推送、发布、替换 `/Applications/OpenCraft.app` 或修改生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- `user-2026-09-22-codex-production`：用户明确要求继续实现 `CodexEngineAdapter`、账户管理 UI、Device Login、OAuth refresh，并明确不要使用 FE-AI change。
- `user-2026-09-22-codex-subscription-parity`：用户要求纯订阅账号行为以 `ref/bb` Account Pooler 为准；自定义模型 ID 与订阅账号路由保持正交。
- `user-2026-09-22-codex-first-turn-transaction`：用户报告新 Codex 会话出现 `no rollout found`，并要求对照 Codex 原版与 BB 修复首轮创建事务。
- 前置实现：`docs/context/tasks/2026-09-22-opencraft-codex-account-pool.md`。

## interface_refs / data_structure_refs
- `opencraft/apps/opencraft-daemon/src/main.ts`
- `opencraft/apps/opencraft-daemon/src/server.ts`
- `opencraft/plugins/builtin-agents/src/index.ts`
- `opencraft/packages/account-pool-host/src/*`
- `opencraft/packages/app-host-{protocol,server,client}`
- 不变量：Host/Engine/Account/Thread 身份分离；真实凭据仅 Host 可读；管理 RPC 返回脱敏投影；登录 transaction 与账户 durable state 分离；AppServer 进程退出/重建不重放已完成 Turn。

## history_context
- `current_design_refs`：`opencraft/docs/platform-architecture.md#host-side-provider-account-pooling`、`opencraft/docs/execution-ownership.md`、`opencraft/docs/architecture/product-identity.md`。
- `relevant_evolution`：Account Pool 基础与真实 AppServer 合成 smoke 已通过；生产 Runtime/UI/OAuth 尚未接入。
- `superseded_refs`：已移除的 FE-AI 工作流目录不再作为任务状态权威。

## acceptance
- Electron/Daemon 暴露一个真实可连接的 Codex Host，完整使用外部 `codex` AppServer 与 Account Pool。
- Settings 可列出、排序、启停、删除 Codex 账号，所有 UI snapshot 无 Token。
- Device Login start/poll/cancel 状态机可用，账号只在 token exchange 和 claims 校验完成后提交。
- 请求前过期 refresh 与 401 单次 refresh 使用 single-flight；刷新失败不会覆盖最后可恢复 secret，也不会无限重试。
- 账号切换使用 BB 的持久 provider cursor 后继顺序；Thread pin 空闲 30 分钟失效且只保留最近 4096 条。
- 主动读取 Codex Usage API，持久化并脱敏投影套餐、额度窗口、重置时间和 ready/held/exhausted/error/disabled 状态；添加、启用、手动刷新及后台刷新复用同一 Host 服务。
- 用户可显式只读导入 Electron Main 注入的外部 `CODEX_HOME`（否则 `~/.codex`）登录；导入不得改写源 `auth.json`，重复账号按 ChatGPT account ID 更新。
- Codex `thread/start` 返回的未持久身份不得先升级 Draft；Host 声明首轮 durability，Workbench 只在首个 `turn/start` 接纳后导航到正式 Thread，确定性失败保留可重试 Draft。
- 通过合成 auth/upstream、真实本地 AppServer 和隔离 Electron 预览验证；不产生外部推理费用。

## affected_paths
- `opencraft/packages/account-pool-host/`
- `opencraft/packages/appserver-protocol/src/codex-accounts.ts`
- `opencraft/apps/opencraft-daemon/`
- `opencraft/apps/workbench-electron/src/{main,daemon-client,desktop-directories,codex-executable}.ts`
- `opencraft/apps/workbench-web/src/runtime/appserver-runtime-context.tsx`
- `opencraft/plugins/builtin-agents/src/codex-accounts/`
- 聚焦测试、Codex smoke、正式架构与 package lock。

## required_context
- 根 `AGENTS.md`
- `opencraft/AGENTS.md`
- `docs/context/domains/identity-access.md`
- `docs/context/project/services/frontend.md`
- `docs/context/project/services/ctl.md`
- `opencraft/docs/platform-architecture.md`
- `opencraft/docs/execution-ownership.md`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库边界、Task Pack、验证要求 | 约束实现、凭据和交付权限 |
| `opencraft/AGENTS.md@working-tree` | OpenCraft 局部所有权 | Host/Engine/凭据/UI 分层与桌面验收 |
| `docs/context/domains/identity-access.md@working-tree` | 登录关键词路由结果 | 明确本地 Codex OAuth 不属于 LightVela user/auth |
| `docs/context/project/services/frontend.md@working-tree` | UI 路由结果 | 明确不修改 frontend 双站产品面 |
| `docs/context/project/services/ctl.md@working-tree` | adapter 路由结果 | 明确不把本机 Codex Engine 放入 CTL |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | OpenCraft 状态所有权与验收方法 | 限定订阅事实由 Host 持有、UI 只消费脱敏投影 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@working-tree` | Host/账户变更验证入口 | 选择聚焦协议测试、真实 AppServer smoke 与跨包门禁 |
| `ref/bb/plugins/account-pool/{PLUGIN_OVERVIEW.md,src/hub.ts,src/store.ts,src/codex-adapter.ts}@62fe3bc46` | 用户指定的订阅行为基准 | 对齐游标、Thread pin、Usage 窗口和状态语义，不复制无关 Claude/嵌套服务能力 |
| `ref/codex/features/conversations/app-server-manager-class.ts@66a586468` | Codex 原版 New chat 创建链 | 确认 `start-conversation` 内完成 Thread 创建和首轮 dispatch，不在两个公开事务之间升级路由 |
| `ref/bb/apps/server/src/services/threads/{thread-create,thread-provisioning}.ts@62fe3bc46` | BB 首轮持久化基准 | 确认 BB 先持久化 pending Thread 与首条消息 checkpoint，再异步 provision Provider |

## evidence
- `npm run test:appserver`：195 项通过。
- `npm run test:extensions`：199 项主测试与 56 项 Collaboration 测试通过。
- `npm run test:identity`、`npm run test:electron-launch`、`npm run typecheck`、`npm run check:boundaries`：通过。
- `npm run build:electron`：通过。
- `npm run smoke:codex-engine`：真实 standalone Codex，经生产 `CodexEngineAdapter` stdio、Account Pool 和本地合成 Responses 完成一轮；外部模型请求 0。
- 隔离 Electron profile：首次默认 Local；Codex Host 可选、连接后模型目录可用；Codex Accounts 设置页入口和空态可见；未点击添加账户。
- documentation 与显式 change-impact 通过；需要 `wisp/mono2-maintainers` Owner review。
- `npx tsx --test tests/account-pool-host.test.ts tests/codex-account-auth.test.ts tests/codex-accounts-settings.test.ts tests/codex-engine-adapter.test.ts tests/desktop-directory-identity.test.ts`：32 项通过，覆盖 BB cursor 后继、30 分钟/4096 pin 治理、Usage 单飞、旧库 migration、只读本机登录导入和脱敏 UI。
- `npm run test:appserver`：201 项通过；`npm run typecheck` 与 `npm run check:boundaries` 通过。
- `npm run smoke:codex-engine` 与 `npm run smoke:codex-account-pool`：真实 Codex AppServer + 本地合成上游通过，均记录 `externalModelRequests: 0`。
- `npm run build:electron` 与 `npm run test:electron-launch` 通过；隔离 profile + CDP 9350 实机确认 Codex 账户页面同时呈现“添加账户”“导入本机 Codex 登录”，未点击导入/登录、未读取真实账号或发起付费推理，Console errors 为空。
- 实机反馈确认启用账户时旧快照被同步 Usage 刷新阻塞，导致共享 Switch 进入 disabled opacity 并呈现近白色；改为启停/导入/登录回执立即返回、Usage 后台单飞刷新。新增 held-usage 回归后 `npm run test:appserver` 202 项通过，Electron Host 重建通过。
- 真实安装数据中故障 Thread `01a0c910-9cf9-7ba0-9371-7bc63029a5da` 只有 shell snapshot/writer lock，`state_5.sqlite.threads` 无记录且无 rollout，证实 Draft 在首轮持久化前被错误升级。Codex 原版将创建与首轮 dispatch 封装在 `start-conversation`，BB 则持久化 pending Thread/首条消息 checkpoint；OpenCraft 据此增加 Host durability capability 和首轮接纳后 promotion。
- 首轮事务整改后：聚焦 27 项、`npm run test:chat` 413 项、`npm run test:appserver` 202 项、全 workspace typecheck、boundary、真实 Codex 合成 smoke 与 Electron build 均通过；确定性 `turn/start` 拒绝不会返回可 promotion 的 Thread receipt。`validate_change_impact.py` 与 `git diff --check` 通过。最新全仓 documentation 校验仅被本任务外 `docs/runbooks/nextgen-dashboard-argocd-cutover.md` 指向已不存在 `scripts/ssm_manifest.nextgen-dashboard.beijing-sandbox.yaml` 的链接阻断，本轮未修改该文档。
- `validate_documentation.py`、显式 `validate_change_impact.py` 与 `git diff --check` 通过；Account Pool 责任面仍要求 `wisp/mono2-maintainers` Owner review。

## risks
- 单进程多 Thread 的生命周期与当前 App Host logical-client 多路复用可能发生所有权冲突；必须先追踪真实 transport owner。
- OAuth device flow 涉及外部协议漂移；边界解析、过期、slow_down、取消和 late poll 必须测试。
- 当前 OpenCraft 一个 Host generation 共享一个物理 Codex AppServer，不能照搬 BB 的每 Thread 进程级 bypass；不得用无效开关冒充等价能力。
- 工作树存在大量未提交修改；避免覆盖现有 Daemon/UI 文件，逐文件核对 diff。

## validation
- 受影响 workspace typecheck、聚焦测试、`test:appserver`、`check:boundaries`。
- 合成 auth/Responses 服务，不使用真实账号或付费推理。
- Electron build 与独立 profile 预览；真实 UI 只验证脱敏状态机。
- documentation/change-impact gates。

## decisions
- 不使用 FE-AI change。
- Account Pool 是唯一 Codex 账户/凭据 owner；Engine 与 UI 都借用其窄端口。
- 纯订阅 parity 先对齐可在现有 Host owner 内成立的调度、Usage 与状态；routing off / Thread bypass 等待独立的直接凭据执行路径，不在共享 AppServer 上伪造。

## scan_scope
- `opencraft/apps/opencraft-daemon`
- `opencraft/apps/workbench-electron`
- `opencraft/plugins/builtin-agents`
- `opencraft/packages/app-host-*`
- `opencraft/packages/account-pool-host`

## scan_output
- `docs/context/tasks/opencraft-codex-production/findings.md`

## handoff
- BB 纯订阅 parity 已补齐游标后继、30 分钟/4096 Thread pin、ChatGPT plan/limit window 主动同步、脱敏状态 UI 与显式只读本机 Codex 登录导入。Codex 首轮创建改为 capability 驱动的 `thread/start → turn/start → Draft promotion`，不再把无 rollout 的临时身份发布为正式会话。源码、合成运行时和 Electron build 已验证；真实外部 Device Login、真实 Usage 响应和付费推理仍需用户主动账号验收。共享单物理 AppServer 下的 routing off / per-Thread bypass 没有伪造，需独立直接凭据执行路径后再实现。
