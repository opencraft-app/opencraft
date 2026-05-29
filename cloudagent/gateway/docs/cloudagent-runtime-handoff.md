# CloudAgent Runtime Handoff

本文档是给后续实现会话用的交接材料。目标是把当前关于 Hermes、
picodingagent、CloudAgent Gateway、ACP 适配和未来 CloudAgent Runtime 的认知
集中落盘，避免新会话重新口头还原。

## Correct Workspace

必须在这个仓库工作：

```text
/Users/skipzhang/code/mono2-clean4/cloudagent
```

不要在旧目录 `/Users/skipzhang/cloudagent` 里继续实现。旧目录里曾经临时补过
类似文档，但实现目标以本目录为准。

## Goal

实现 CloudAgent Runtime 的核心 session / transcript / inbox 调度模型。

外部协议仍然是 ACP，Gateway 只做适配；真正的 agent 运行状态应该收敛到
CloudAgent Runtime，而不是散落在 ACP Gateway 的内存字段里。

目标语义：

```text
ACP client
  -> Gateway, ACP adapter, auth/scope, files
  -> CloudAgent Runtime RPC
  -> Runtime inbox, pump, run ledger, transcript
  -> model adapter and sandbox tools
```

第一版也不要在 Gateway 内落兼容 shim queue。Gateway 可以保留 auth、文件、生命周期、
bootstrap 和 read projection，但 `prompt/steer/follow_up/abort` 的调度事实必须直接进入
CloudAgent Runtime。

当前实现契约：

- ACP `session/prompt` 默认映射为 `prompt`。
- ACP `session/prompt` 可通过 `_meta.cloudagent.inbox_mode` 指定 `prompt`、`steer`
  或 `follow_up`。
- Gateway 只校验并透传 inbox mode 到 worker job。
- sidecar worker 调用 runtime daemon `session-input --inbox-mode <mode>`。
- MyChat 通过 `_cloudagent.session.status` 展示 runtime `run_ledger_tail`、
  pending counts 和 reconcile/blocking reason。

## Decisions Already Made

- 只支持 Wisp 模式作为主要可恢复 runtime；不需要继续兼容 AGS-only 作为长期目标。
- Gateway 跑在 K8s；CloudAgent Runtime 跑在沙箱里。
- ACP 只是 Gateway 对外暴露的协议；内部应该用 CloudAgent 自己的 RPC。
- `acp_session_id == runtime_session_id` 可以作为第一版身份映射。
- 不让 Gateway 拼装 prompt 历史来假装 agent context 恢复。
- `ACPSessionRuntimeStartRequest` 不携带 Gateway `History`；runtime start/recovery
  不允许再调用 sidecar bootstrap 灌入 Gateway UI history。
- 真实恢复应基于 Runtime 自己的 transcript / run ledger。
- 如果同一个可见 session 需要启动全新 agent transcript，UI 应插入 reset marker，
  表示上下文已经断开。
- v1 transcript 可以线性 append-only，但 entry schema 要预留
  `entry_id / parent_id / turn_id`，以后支持 branch/tree/fork/compaction 时不用重迁移。
- `prompt` 默认排队，不抢占 active run。
- 只有显式信号或 gate 允许打断 active run。
- `session/load` 可以继续读 Gateway projection，但不能启动 runtime，也不能把 Gateway
  UI history 当作 agent context truth。
- Wisp recreate 在 Runtime transcript/run ledger 可恢复前只能算 runtime 重新连接或 reset，
  不能声称语义恢复。

## Hermes Findings

Hermes Python 已支持打断和队列，但主要分布在 gateway / adapter 层：

- `run_agent.py` 的 `AIAgent` 有 interrupt 状态、执行线程跟踪、active child 跟踪。
- Hermes 在 streaming / non-streaming API 调用中会检查 interrupt，并关闭连接。
- `/stop` 会调用 `agent.interrupt("Stop requested")`。
- gateway 会跟踪 running agent；active session 收到新消息时走 interrupt / queue 路径。
- 运行结束后会处理 pending event；有最大 interrupt depth 保护。
- Discord 侧还有 `/queue`，语义是排到下一轮而不打断。

结论：

Hermes 有“运行中可打断 + 下一轮 pending 消息”的能力，但它不是一个
Runtime 级 durable inbox / run ledger。CloudAgent 不应直接复制 Hermes gateway
pending queue，而应把这些能力下沉为 Runtime 原语。

## picodingagent Findings

`/Users/skipzhang/code/picodingagent` 已经有更接近目标的原语设计：

- README 明确写了 ordinary messages should queue by default。
- Runtime 入口是 `EnqueuePromptLike + Pump`。
- `runtime/kernel.go` 有三类 pending：
  - `PendingSteer`
  - `PendingNormal`
  - `PendingFollowUp`
- active run 时：
  - `steer` 进入高优先级队列，并请求 abort；
  - 如果已经 saw tool call，则在 tool result 边界取消；
  - `follow_up` 只排队，不打断；
  - 未指定 inbox mode 时 active run 会要求调用者显式选择。
- 消费优先级是：

```text
steer -> normal prompt -> follow_up
```

这些是 CloudAgent Runtime 应该学习的核心设计，不是 UI 层技巧。

## Runtime Input Modes

### prompt

普通用户输入。ACP `session/prompt` 未带私有扩展时默认映射为 `prompt`。

语义：

- Runtime idle 时立即执行。
- Runtime active 时进入 normal queue。
- 不抢占当前 run。

### steer

显式打断或改向。

语义：

- 进入高优先级队列。
- 如果有 active run，Runtime 请求当前 run abort。
- 如果 run 已进入工具调用阶段，优先在工具结果边界取消，避免破坏 tool call/result
  顺序。
- 下一轮优先处理 steer。

ACP 私有扩展建议：

```json
{
  "_meta": {
    "cloudagent": {
      "inbox_mode": "steer"
    }
  }
}
```

### follow_up

显式后续任务。

语义：

- 不打断当前 run。
- 当前 run 完成后继续处理。
- 排在 normal prompt 之后。

ACP 私有扩展建议：

```json
{
  "_meta": {
    "cloudagent": {
      "inbox_mode": "follow_up"
    }
  }
}
```

### abort / stop

控制信号，不是 prompt-like 输入。

语义：

- 停止当前 active run。
- 可带参数决定是否清空 pending queue。
- 不创建新的 assistant turn。
- 必须在 run ledger 里记录 canceled / aborted 状态。

建议参数：

```json
{
  "clear_pending": false,
  "reason": "user_stop"
}
```

## Runtime Data Model

### Session

Session 是长期可见会话身份。第一版可直接使用 ACP session id：

```text
runtime_session_id = acp_session_id
```

### Run Ledger

Run ledger 是执行事实表，至少需要：

```text
run_id
session_id
turn_id
source
inbox_mode
status: queued | running | aborting | succeeded | failed | canceled | blocked
created_at
started_at
completed_at
error_code
error_message
blocked_reason
```

用途：

- 浏览器刷新后恢复可见状态。
- Runtime 重启后判断 active / pending / blocked。
- 排障和性能 timeline。

### Transcript

Transcript 是 agent context 和 UI 展示的持久事实。Gateway 不应该通过
`History []acpHistoryEntry` 来临时重建核心上下文。

第一版 entry schema 建议：

```json
{
  "entry_id": "entry_xxx",
  "parent_id": "entry_prev_or_branch_parent",
  "turn_id": "turn_xxx",
  "run_id": "run_xxx",
  "role": "user|assistant|system|tool",
  "blocks": [
    {"type": "text", "text": "..."}
  ],
  "created_at": "2026-05-24T00:00:00Z"
}
```

第一版线性 append-only 即可；保留 `parent_id` 是为了后续 branch/tree/fork。

## Current Gateway State In This Repo

关键文件：

- `gateway/internal/wrapper/acp_gateway.go`
- `gateway/internal/wrapper/acp_runtime.go`
- `gateway/internal/wrapper/store_events.go`
- `gateway/internal/wrapper/store_migrations.go`
- `gateway/internal/wrapper/server_acp_test.go`
- `gateway/internal/wrapper/wisp_outer_runtime.go`
- `gateway/internal/wrapper/workspace_service.go`
- `gateway/internal/wrapper/store_workspace.go`

当前已有能力：

- ACP `session/new / load / resume / prompt / cancel / close / delete`。
- SQLite `sessions / turns / messages / message_blocks`。
- `session_runtimes` 已包含 Wisp 相关字段。
- Wisp recoverable runtime 已有基础：
  - `OuterRuntime`
  - `RuntimeRecovery`
  - `WispSMHSpaceID`
  - `WispName`
  - `WorkspaceRecord`
  - `runtimeCanRecreate(...)`
  - `EnsureSessionRuntime(...)`
- Gateway 恢复判定不能只依赖 `session_runtimes` 中的 Wisp 字段；正式恢复依据包括 workspace store 中 owner_session_id / workspace_id 对应的可恢复 Wisp/SMH `WorkspaceRecord`。
- `session/load` 会从 `message_blocks` replay UI。
- `session/resume` 和 prompt preflight 已能通过 `EnsureSessionRuntime` 尝试恢复 Wisp runtime。
- `session/close` 对 Wisp 会保留可恢复 runtime anchor。
- `session/delete` 会走 runtime delete。

当前缺口：

- active prompt 时第二个 `session/prompt` 已进入 Runtime inbox；需要继续补更完整的
  public RPC pending 可见性和 E2E 覆盖。
- `session/prompt` 已支持 `_meta.cloudagent.inbox_mode` 并透传到 sidecar
  `session-input --inbox-mode`。
- Gateway 内没有 pending normal / steer / follow_up 队列。
- 现有 `turns/messages/message_blocks` 更像 UI transcript，不是完整 Runtime run ledger。
- `History []acpHistoryEntry` 已从 runtime start/recovery 请求中移除；Gateway history 只保留
  UI projection 语义。
- Runtime 仍沿用 `hermes-sidecar` crate / binary 名称；语义主干已经开始切到
  CloudAgent Runtime，但包装命名还没有完全去旧名。

## Current Implementation Snapshot

截至 2026-05-24，本分支已完成第一轮真实主干切换：

- `hermes-core::AgentRuntime` 已有 inbox + pump + run ledger + transcript store。
- `run_turn` 语义已经降级为 `enqueue(prompt) -> pump_until_idle -> completion`。
- daemon 已新增 Runtime-native API：
  - `POST /session/create`
  - `POST /session/input`
  - `POST /session/input/stream`
  - `POST /session/abort`
  - `GET /session/status`
  - `GET /session/transcript`
  - `GET /session/run-ledger`
- sidecar client 已新增：
  - `session-create`
  - `session-input`
  - `session-abort`
  - `session-status`
  - `session-transcript`
  - `session-run-ledger`
- Gateway 启动 daemon 后会先调用 `session-create`，把
  `agent_version/workspace_version` 写入 Runtime session。
- Gateway `session/prompt` 的 Worker.Run 命令已改为 `session-input`，保留现有
  `WRAPPER_EVENT_JSON/WRAPPER_RESULT_JSON` streaming 投影。
- Gateway `session/cancel` 已改为 Runtime `session-abort`，不再把普通 cancel 当成
  runtime cleanup / outer sandbox close。
- OpenAI `/v1/responses` 已改为在短生命周期 outer sandbox 内启动 runtime daemon，
  执行 `session-create -> stage-files -> session-input -> shutdown`，不再无参 one-shot
  执行 sidecar。
- sidecar 已删除 legacy `one-shot/bootstrap/prompt/cancel` runtime 入口；保留的控制面是
  `session-create/session-input/session-abort/session-status/session-transcript/session-run-ledger/stage-files/ensure-inner/shutdown`。
- runtime event demux 只按 `run_id` 投递；多个 active prompt 时不再把无 scope 事件随机投给
  任意 stream。
- `AgentExecutor` 已接入 prompt transform hooks 和 tool gate hook；sidecar 可通过
  `CLOUDAGENT_SELECTED_SKILLS` 和 `CLOUDAGENT_DENY_TOOLS` 装配 v1 行为。
- MyChat 已解析并展示 `runtime_status`，不再把 Runtime run status 塞进
  `restoreState`。

## Recommended Implementation Slices

### Slice 1: Runtime-native daemon API

目的：直接把旧 sidecar daemon 契约从 `bootstrap/prompt/cancel/output_text`
改成 Runtime-native control API。不要先在 Gateway 内做 shim queue；那会继续把调度事实
留在错误层。

目标 binary 仍可沿用现有 sidecar 发布链路，但语义上应重命名和收口为：

```text
cloudagent-runtime
  serve
  call
```

内部协议不要用 ACP。HTTP JSON 或 line-delimited JSON 都可以起步，但操作必须是
runtime 语义：

- `session.create`
- `session.input`
- `session.abort`
- `session.status`
- `session.transcript`
- `session.run_ledger`
- `events.subscribe`

第一版 payload 直接承载：

```json
{
  "session_id": "session_xxx",
  "inbox_mode": "prompt|steer|follow_up",
  "blocks": [
    {"type": "text", "text": "..."}
  ]
}
```

### Slice 2: Runtime kernel and control state

基于 `hermes-core::AgentRuntime` 继续做实，而不是另起一个语义 runtime。参考
`picodingagent/runtime/kernel.go` 和 `runtime/runtime_pump.go`：

- `prompt`：idle 时执行，active 时排 normal queue。
- `steer`：排 high priority queue，并把 active run 标记为 aborting。
- `follow_up`：排 follow-up queue，不打断。
- `abort`：控制信号，可选择是否清 pending。
- pump 顺序固定为 `steer -> prompt -> follow_up`。

这一层需要有 run ledger 和 transcript entry 的内核模型，即使 v1 仍然是内存或文件存储。

### Slice 3: Runtime transcript and run ledger durability

新增 Runtime-owned 持久事实，避免复用 Gateway UI transcript 表承载 agent context 和
执行事实：

实现位置先固定为：

```text
cloudagent/research/hermes-rs/crates/hermes-core/src/runtime/store.rs
```

并从 `runtime/mod.rs` 暴露 `pub mod store;`。不要在 `session.rs` 仍是单文件模块时创建
`src/session/` 目录，避免 Rust module layout 混乱。

```text
runtime_runs:
  run_id
  session_id
  turn_id
  source
  inbox_mode
  status
  created_at
  started_at
  completed_at
  error_code
  error_message
  blocked_reason

runtime_transcript_entries:
  entry_id
  parent_id
  turn_id
  run_id
  role
  blocks
  created_at
```

Gateway 可以保留 projection/read model 供 `session/load` 冷启动展示使用，但 Runtime 是
write-side truth。Wisp 语义恢复必须等 Runtime transcript/run ledger 可恢复后才算完成；
在此之前 runtime recreate 只能展示 reset marker，不能声称恢复原 agent context。

### Slice 4: Gateway adapter rewrite

Gateway 保留：

- auth / caller scope
- file upload/download control plane
- outer sandbox lifecycle and runtime bootstrap/session binding
- runtime RPC transport
- UI/ACP read projection

Gateway 删除或退役：

- active prompt guard 作为调度语义。
- `History []acpHistoryEntry` 作为 agent context 来源。
- `CurrentPrompt` 作为 session 真相源。

`session/prompt` 应解析 `_meta.cloudagent.inbox_mode`，然后提交给 Runtime `session.input`。
`session/cancel` 应转成 Runtime `session.abort`。Gateway 只投影 queued/running/aborting/
blocked/succeeded/failed/canceled 状态，不再自己决定 agent loop。

### Slice 5: Event projection and client semantics

ACP/OpenAI/MyChat 消费 Runtime `AgentEvent` 和 run ledger 投影：

- tool call/update 必须使用真实 tool name。
- queued/running/aborting/blocked 必须可见。
- abort 不伪造新的 assistant turn。
- protocol adapters 不写 agent decision semantics。

MyChat 侧 runtime run status 应建成独立字段，不要塞进现有 `restoreState`：

- `restoreState` 继续表示连接、恢复、只读状态。
- runtime run status 表示 `queued/running/aborting/blocked/succeeded/failed/canceled`。
- 需要覆盖 `mychat/src/lib/acpClient.ts` 的状态解析、`sessionState.ts` 的 row model、
  `sessionCoordinator.ts` 的 reducer/effects，以及 `App.tsx` 的 runtime panel 展示。

### Slice 6: Packaging and destructive cleanup

沿用当前 build/sign/upload/registry 发布链路，但产物语义切到 `cloudagent-runtime`：

- build runtime ELF。
- detached `.sig` 签名。
- 上传 binary + `.sig`。
- registry 只解析注册版本或签名校验过的自定义 URL。
- 删除旧 sidecar prompt loop 兼容分支。

### Slice 7: Move transcript truth out of Gateway history

不要继续让 Gateway 拼 `History` 作为 agent context 恢复来源。Runtime 应持久化自己的
transcript，并在重启后从 transcript 还原 agent context。

如果 Runtime 判断旧 transcript 不可恢复，则应产生 reset marker，而不是静默拼出一个
不可信上下文。

## Tests To Add

### Runtime kernel tests

- active run + normal prompt queues instead of reject.
- active run + `follow_up` queues and does not interrupt.
- active run + `steer` marks current run aborting and queues steer first.
- queue priority is `steer -> prompt -> follow_up`.
- `abort(clear_pending=true)` drops pending inputs and records canceled/aborting status.
- transcript entries include `entry_id / parent_id / turn_id / run_id`.

### Gateway adapter tests

建议更新 `gateway/internal/wrapper/server_acp_test.go`：

- active prompt + second normal prompt 被 Gateway 接收并提交 Runtime，而不是返回
  `session already has an in-flight prompt`；public `session/prompt` RPC 仍挂起到该
  run 完成，queued 状态通过 Runtime status/run ledger 观察。
- `_meta.cloudagent.inbox_mode=follow_up` 会投影到 Runtime input。
- `_meta.cloudagent.inbox_mode=steer` 会投影到 Runtime input，并触发 Runtime abort。
- invalid inbox_mode 返回 JSON-RPC error，且不创建 Runtime input。
- `session/load` 只读 Gateway projection，不启动 runtime。

### Persistence tests

- runtime run ledger 写入 queued/running/succeeded/failed/canceled/blocked。
- transcript parent linkage 保持线性 parent_id。
- Runtime process restart 后 transcript 可还原。
- pending inbox 可恢复。
- active run 崩溃后 status 进入 failed / interrupted，不丢 transcript。

## Caution

- 当前 worktree 有大量已有修改和 untracked 文件，默认不要清理或重置。
- 不要删除用户已有变更。
- 不要在测试或文档里写入真实 SecretId、SecretKey、API key。
- 不要为了实现 queue 把所有 prompt 放进 goroutine 后无序执行；必须保持每个 session
  串行 pump。
- 不要把 `steer` 当成普通 cancel；它是“取消当前 run 并排入一个高优先级新输入”。
- 不要让 Gateway 成为调度事实源；不要新增 Gateway shim queue。

## Useful Verification Commands

从正确目录运行：

```bash
cd /Users/skipzhang/code/mono2-clean4/cloudagent
go test ./gateway/internal/wrapper -run 'TestACP.*(Prompt|Queue|Steer|Follow|Cancel|Wisp)' -count=1
go test ./gateway/internal/wrapper -count=1
```

如果涉及前端：

```bash
cd /Users/skipzhang/code/mono2-clean4/cloudagent/mychat
pnpm test -- --runInBand
pnpm build
```

## Current Best First Step

先做 runtime-native daemon boundary，而不是 Gateway shim：

1. 继续把 `hermes-core::AgentRuntime` 做实为 runtime kernel。
2. 把 sidecar daemon API 改成 `session.input/session.abort/session.status/session.transcript/session.run_ledger/events.subscribe`。
3. 让 Gateway `session/prompt` 只提交 Runtime input，删除 in-flight guard 的调度职责；
   public `session/prompt` 仍保持同步流式合同。
4. 保留 Gateway projection/read model，但它只由 Runtime events/run ledger 喂数据。
