# OpenCraft 跨会话编排、3+1 驱动与可重建读取缓存实施规范 (Spec)

> 状态：Stage 0、Codex Stage 1 与 Stage 3 独立宿主驱动已接入；Stage 2 UI 已实现。实际可用性仍由独立宿主的能力握手与部署验收决定。已实现接口以[协作契约](../docs/actor-collaboration-api.md#thread-orchestration-control-ledger)和[Core 契约](../docs/codex-core.md)为准（对应架构文档：[thread-orchestration-architecture.md](thread-orchestration-architecture.md)）
> 目标：在遵循“执行侧平滑升级（引擎进程由长驻宿主持有）”、“原生日志为唯一正文真源”、“多人 `identity-core` 有界委托与 Token Spec 系统来源归属”的前提下，提供可直接编码与验收的接口契约、SQLite 表结构、缓存重建规则及分阶段实施计划。

---

## 1. 范围与非目标 (Scope & Non-Goals)

### 1.1 目标范围
1. **读写解耦与可重建读取缓存（Stage 0，可独立先行）**：解耦 UI 点击会话的只读加载（`Read`）与唤醒引擎（`Resume`）；在受管 `<dataDirectory>/cache/transcripts/` 下建设带 `projection_schema_version` 与 `native_watermark` 的可重建预折叠缓存，与 Token 统计共用同一套 Codex rollout 增量读取器。
2. **跨网关重启无损的 `AgentDriverContract` 与 `ThreadOrchestrationBroker`（Stage 1）**：定义网关与独立长驻 Engine Host（Codex Core / 拆分后 AppServer 宿主、独立 DSH Host、独立 Pi Host、ACP/Claude Host）之间的驱动契约、进行中工具调用的幂等重连重放协议、以及与 `@opencraft/host-recovery`（被打断轮次自动续跑）协同的父子通知状态机。
3. **多人权限委托与 Token 归属对齐**：复用 `access-control/collaboration` 的有界用户委托（Bounded User Delegation）与 `actors.sqlite` 资源授权；子会话由 Agent 触发的消耗按 Token Spec 记入 `sourceKind: "system"`。
4. **`SubagentTimelineBlock` 三态分离投影与 3+1 异构驱动接入（Stage 2~3）**。

### 1.2 非目标
- **绝不在执行网关进程内直接拉起或持有引擎子进程**（Codex、DSH、Pi、Claude SDK、ACP 均必须运行在独立长驻 Engine Host unit 中）。
- **绝不把 `.turns.jsonl` 当作第二份不可丢的权威历史库**（权威正文永远在各引擎原生日志中；缓存损坏或版本升级时直接从原生日志重建）。

---

## 2. 核心 TypeScript 接口契约

### 2.1 身份委托、结构化消息溯源与关系类型（对齐 `identity-core` 与 `collaboration`）

```typescript
/** 遵循 opencraft://conversation/v1/<encoded-server>/<encoded-thread> */
export interface ConversationRef {
  readonly serverId: string;
  readonly threadId: string;
}

export type ThreadVisibility = "visible" | "hidden";

export type MessageOriginKind =
  | "user"                 // 已认证自然人从 Workbench 直接提交或 Steer
  | "agent"                // 其他会话通过 thread_spawn / thread_tell 投递
  | "parent_system_notice" // 子会话终态/卡审批时由 Broker 投递给父会话的聚合通知
  | "system";              // 宿主级自动续跑 (@opencraft/host-recovery) 或系统指令

/**
 * 扩展 access-control/collaboration 的来源记录：
 * 连接企业身份 (human Actor)、有界委托人与会话级因果链。
 */
export interface MessageOrigin {
  readonly kind: MessageOriginKind;
  readonly clientMessageId: string;
  /** 本次输入的直接行动 Actor（人工输入为 human://...，会话工具调用为 session://... 或受托上下文） */
  readonly authorActorId: string | null;
  /** 触发本次自动化链条的源头自然人 Actor（来自有界用户委托，用于权限核验与未来委托成本追溯） */
  readonly delegatorActorId: string | null;
  /** 关联的有界委托 ID（验证有效期、撤销代次与剩余配额） */
  readonly delegationId: string | null;
  /** 发送方会话稳定引用（人工直接输入时为 null） */
  readonly senderConversation: ConversationRef | null;
  readonly senderTurnId?: string | null;
  readonly operationId?: string | null;
  readonly replyExpectation: "required" | "none";
  readonly delegationRevision: number;
  /** Token 统计来源分类：人工输入为 "human"，Agent 触发/父子通知/自动续跑固定为 "system" */
  readonly usageSourceKind: "human" | "system";
  readonly createdAtMs: number;
}

export interface ThreadRelationships {
  readonly parentThreadId: string | null;
  readonly lifecycleOwnerThreadId: string | null;
  readonly forkedFromId: string | null;
  readonly visibility: ThreadVisibility;
  readonly ownerActorId: string | null;
  readonly delegationRevision: number;
}
```

### 2.2 面向长驻 Engine Host 的驱动契约（`AgentDriverContract`）

`AgentDriverContract` 在网关侧是统一的 TypeScript 调用接口，底层通过 Unix Domain Socket / Loopback RPC 连接到**独立长驻的 Engine Host 进程**（绝不在网关进程内 `spawn` 引擎）：

```typescript
export type AgentDriverKind = "codex" | "claude-code" | "pi" | "dsh" | "acp";

export interface NativeWatermark {
  /** 如 Codex rollout 的 inode:byteOffset 或 DSH/Pi 的 lastEventSeq */
  readonly cursor: string;
  readonly updatedAtMs: number;
}

export interface NativeHistoryPort {
  /** 轻量获取原生日志当前最新水位，用于判断可重建缓存是否落后 */
  getCurrentWatermark(params: {
    readonly threadId: string;
    readonly nativeSessionId: string;
  }): Promise<NativeWatermark | null>;

  /**
   * 从指定水位增量或分页读取原生 Turn（Codex 必须与 Token 统计共用同一个 rollout 增量读取器）
   */
  readTurnsSinceWatermark(params: {
    readonly threadId: string;
    readonly nativeSessionId: string;
    readonly afterWatermark: string | null;
    readonly limit: number;
  }): Promise<{
    readonly turns: readonly AppServerTurn[];
    readonly newWatermark: NativeWatermark;
    readonly hasMore: boolean;
  }>;
}

/**
 * Engine Host 向网关回调执行 Server-Owned 工具时的幂等请求包。
 * 当网关重启导致连接闪断时，Engine Host 必须在本地退避重连（最长 15s）并用相同 toolCallKey 重放。
 */
export interface ServerToolInvocationEnvelope {
  readonly toolCallKey: string; // 格式: "${sourceThreadId}:${turnId}:${callId}"
  readonly sourceThreadId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly delegationId: string;
  readonly toolName: "thread_spawn" | "thread_tell" | "thread_inspect" | "thread_wait";
  readonly arguments: Record<string, unknown>;
}
```

实际 `AgentDriverContract` 与 `AgentOrchestrationPort` 由
`packages/appserver-client/src/agent-driver.ts` 持有，Broker 的
`OrchestrationExecutionPort` 为同一类型。Pi 使用独立 Host 中的 durable SDK；
不把该实现称为 stdio RPC。DSH 的新 ACP 代使用独立 Host 内的
`--profile acp` 进程，旧原生 Web Host 与会话继续由原 owner 持有。
Claude 通过独立 ACP Host 连接显式配置的 Claude SDK/ACP 桥接命令。

非 Codex 宿主的内置编排工具不属于浏览器工具 lease。Host 用受管私有
descriptor 与签名会话身份访问 Gateway 的 `/orchestration`，在最多 15 秒
内重新发现端点并重放相同调用。幂等键包含 server scope、Host incarnation、
Thread、Turn 与 native call ID；权限仍从持久输入委托派生，Host 不能用
回调正文伪造自然人。Renderer 不能直接调用宿主控制方法。

跨引擎 spawn 先验证 source 的工作区/权限边界，再冻结 destination 的
模型、参数与宿主代次。Pi/ACP 无法保持受限 source 权限时在创建前拒绝；
不把源引擎模型名带入另一引擎。`driver: "dsh"` 选择新 `dsh-acp` Host，
原生代次注册表继续拥有会话路由，升级只改变新建默认代，旧会话排空后才退休。

### 2.3 模型上下文中的 `MessageOrigin` 格式化规则
当 `origin.kind !== "user"` 时，Driver 在送入底层模型前将其包装为结构化上下文头（而保存在控制账本与缓存中的 UI 数据保持纯正文本 + 结构化 `origin` 字段）：

```xml
<!-- origin.kind === "agent" -->
<opencraft_thread_message from="opencraft://conversation/v1/local/thread-example" reply_expectation="required">
请帮我检查 auth 模块的 token 刷新逻辑。
</opencraft_thread_message>

<!-- origin.kind === "parent_system_notice" -->
<opencraft_child_update batch_size="2" reply_expectation="none">
- Child @thread:thread-example ("修复登录单测") completed.
  Direct user input occurred in this turn ("顺便把超时改成 5s"); user instructions take precedence over your earlier delegation.
  Summary: 已修复单测并将超时调整为 5s。
</opencraft_child_update>
```

---

## 3. Server-Owned 编排工具 Schema 与跨网关重启重放语义

所有工具调用均由长驻 Engine Host 捕获并通过 `ServerToolInvocationEnvelope` 发往网关 Broker：
- **幂等承诺**：网关 Broker 在执行任何副作用前，先以 `toolCallKey` 写入 SQLite。若网关在执行后、返回响应前重启，Engine Host 重连重放同一 `toolCallKey` 时，新网关直接返回已落盘的 `result_json`，确保子会话不重复创建、消息不重复投递、工具不因网关重启报错。
- **权限承诺**：每次调用强制校验 `delegationId` 对应的自然人 `issuerActorId` 是否有效、未撤销、未超配额（默认每委托最多 8 次跨会话写操作），并向 `access-control/collaboration` 核验目标会话权限。

### 3.1 四个内置工具契约
1. **`thread_spawn`**：
   - 输入：`{ title?, prompt, parentSelf?: true, bindLifecycleToSelf?: true, visibility?: "visible"|"hidden", driver?, model?, reasoningEffort?, cwd?, idempotencyKey? }`
   - 默认 `visibility: "hidden"`，作为 subagent 仅从父对话进入；只有用户明确要求独立、长期会话才传 `visible`。已有关系不迁移，历史表默认值保留兼容，Broker 显式写入新默认。
   - 权限：新建子会话的 `ownerActorId` 继承 `delegation.issuerActorId`；消耗配额 1 次；首轮输入标记 `usageSourceKind: "system"`。
   - 返回：`{ operationId, threadId, status: "starting", durability: "immediate" | "pending_first_turn", delivery: "sent" }`。
2. **`thread_tell`**：
   - 输入：`{ threadId, message, mode?: "queue"|"steer", expectedTurnId?, replyExpectation?: "required"|"none", idempotencyKey? }`
   - 权限：核验 `delegation.issuerActorId` 对目标 `threadId` 的 `execution.queue` 或 `execution.steer` 权限（不可越权操作他人私有会话）；`mode: "steer"` 必须提供 `expectedTurnId` 且不静默回退为 `queue`（对齐 `actor-collaboration-api.md`）。
   - 返回：`{ operationId, threadId, delivery: "submitted" | "injected" | "queued" | "unknown", waitingOn, delegationRevision }`。
3. **`thread_inspect`**：
   - 输入：`{ threadId, includeRecentTurns?: 1..5 }`
   - 权限与安全边界：核验读取权限；**严格遵循 `conversation-interoperability.md`，只返回用户与助手文本摘要（上限 24 KiB），绝不返回工具输出、Blob 或凭据**；遵守 `EXO-01` 绝不唤醒底层引擎。
4. **`thread_wait`**：
   - 输入：`{ threadIds: string[], waitFor?: "all_settled"|"any_settled", timeoutMs?: 0..5000 }`
   - 行为：在 SQLite 登记持久 `waitTicket` 并立即释放当前会话串行锁；最多等待 `timeoutMs`（默认 3000ms）。若超时仍未完成（或子会话正处于 `@opencraft/host-recovery` 自动续跑中），返回 `{ settled: false, waitTicketId, threads }`，由后续 `parent_system_notice` 异步唤醒父会话。

---

## 4. 控制账本与可重建读取缓存规格

所有文件均位于 `docs/architecture/product-identity.md` 与 `docs/sqlite-lifecycle.md` 解析出的受管 Host `dataDirectory` 下（严禁使用 `~/.opencraft`）。

### 4.1 控制账本增量表（归属 `actor-collaboration.sqlite` v3 迁移 / `opencraft-threads.sqlite`）

```sql
-- 1. 会话编排关系与状态表（权威控制数据，不可丢弃）
CREATE TABLE IF NOT EXISTS opencraft_thread_relations (
  thread_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  driver_kind TEXT NOT NULL,
  engine_host_generation TEXT, -- 对齐 DSH/Engine Host 多代排空 generationId
  native_session_id TEXT,
  owner_actor_id TEXT,         -- human://<domain>/<id>
  parent_thread_id TEXT,
  lifecycle_owner_thread_id TEXT,
  forked_from_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'visible',
  runtime_status TEXT NOT NULL DEFAULT 'idle', -- starting | active | recovering | awaiting_interaction | idle | error
  delegation_revision INTEGER NOT NULL DEFAULT 0,
  auto_exchange_depth INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
) STRICT;

-- 2. Server-Owned 工具调用与编排操作幂等账本（跨网关重启重放依据）
CREATE TABLE IF NOT EXISTS opencraft_orchestration_operations (
  operation_id TEXT PRIMARY KEY,
  tool_call_key TEXT UNIQUE,   -- "${sourceThreadId}:${turnId}:${callId}"
  idempotency_key TEXT UNIQUE,
  delegation_id TEXT NOT NULL,
  issuer_actor_id TEXT NOT NULL,
  kind TEXT NOT NULL,          -- spawn | tell | wait
  sender_thread_id TEXT NOT NULL,
  target_thread_id TEXT NOT NULL,
  client_message_id TEXT UNIQUE, -- 关联 OpenCraftHostQueue 的 "actor-input:<requestId>"
  mode TEXT NOT NULL,          -- start | queue | steer | wait
  state TEXT NOT NULL,         -- accepted | queued | submitted | injected | unknown | rejected | cancelled
  waiting_on TEXT,             -- turn_active | turn_starting | interaction | recovering | null
  result_json TEXT,            -- 已落盘的工具回执，供网关重启后 Engine Host 重放直接返回
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

-- 3. 父子通知持久防抖批次表（配合 @opencraft/host-recovery 去重）
CREATE TABLE IF NOT EXISTS opencraft_parent_notification_batches (
  batch_id TEXT PRIMARY KEY,
  parent_thread_id TEXT NOT NULL,
  child_thread_id TEXT NOT NULL,
  child_root_turn_id TEXT NOT NULL, -- 使用自动续跑保持不变的 root turn ID
  outcome_kind TEXT NOT NULL,       -- completed | failed | exhausted | unconfirmed | interrupted_by_user | awaiting_interaction
  has_direct_user_input INTEGER NOT NULL DEFAULT 0,
  user_input_excerpt TEXT,
  summary_json TEXT NOT NULL,
  first_queued_at_ms INTEGER NOT NULL,
  deliver_after_ms INTEGER NOT NULL,
  max_deadline_ms INTEGER NOT NULL,
  UNIQUE(parent_thread_id, child_thread_id, child_root_turn_id, outcome_kind)
) STRICT;

-- 4. 持久等待票表（跨网关重启恢复等待订阅）
CREATE TABLE IF NOT EXISTS opencraft_wait_tickets (
  wait_ticket_id TEXT PRIMARY KEY,
  caller_thread_id TEXT NOT NULL,
  caller_turn_id TEXT NOT NULL,
  target_thread_ids_json TEXT NOT NULL,
  wait_for TEXT NOT NULL,
  state TEXT NOT NULL, -- active | satisfied | expired | cancelled
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
) STRICT;
```

### 4.2 可重建读取缓存（`<dataDirectory>/cache/transcript-index.sqlite` + `.turns.jsonl` + `.blobs/`）

当前缓存实现位于 `packages/native-history-node/`。Codex 复用 Token 统计的 rollout 字节增量读取器，交给原生只读分页器投影 Turn；Pi 只读 SQLite/WAL 快照，DSH 通过原生 persistence 的 list/locate 定位全部会话代日志，再以规范只读投影对共享缓存做稳定前缀差分。缓存命中只核原生水位，不创建 Pi Harness 或 DSH 执行 owner。追加与未完成尾轮更新保持分页 epoch；来源替换、历史前缀改写或投影版本变化重建。完整 Item 响应沿用当前 wire contract，磁盘 Blob 在请求该页时还原；单独的预览与 Blob 拉取协议留待后续阶段。

按照 `docs/sqlite-lifecycle.md` 第 1 节“可重建的副本/索引”管理，独立于权威控制库，随时可整库/整目录删除重建：

```sql
CREATE TABLE IF NOT EXISTS opencraft_cache_meta (
  thread_id TEXT PRIMARY KEY,
  projection_schema_version INTEGER NOT NULL,
  native_watermark TEXT NOT NULL, -- 如 rollout 文件的 "inode:size:byteOffset" 或 DSH "seq"
  total_turns INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS opencraft_turn_offset_index (
  thread_id TEXT NOT NULL,
  turn_seq INTEGER NOT NULL,
  turn_id TEXT NOT NULL,
  byte_offset INTEGER NOT NULL,
  byte_length INTEGER NOT NULL,
  status TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (thread_id, turn_seq),
  UNIQUE (thread_id, turn_id)
) STRICT;

CREATE TABLE IF NOT EXISTS opencraft_cache_blobs (
  thread_id TEXT NOT NULL,
  turn_seq INTEGER NOT NULL,
  blob_sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  PRIMARY KEY (thread_id, turn_seq, blob_sha256)
) STRICT;
```

#### 缓存读取、对账与清理确定性规则
1. **读取对账（Read-time Watermark Check）**：
   - `thread/read` 收到请求时，先读取 `opencraft_cache_meta(thread_id)`。
   - 若记录不存在，或 `projection_schema_version !== CURRENT_PROJECTION_SCHEMA_VERSION`，触发从 `NativeHistoryPort` 全量流式重建。
   - 若存在且版本匹配，调用 `NativeHistoryPort.getCurrentWatermark()`（对本地 Codex rollout / DSH 文件仅一次轻量 `stat`）：
     - 水位一致：直接查 `opencraft_turn_offset_index` 最后 10 轮，通过 `fs.read(fd, buf, 0, len, offset)`（`pread`）返回；
     - 水位落后（如崩溃恢复或后台 Turn 刚写入原生日志）：调用 `readTurnsSinceWatermark(afterWatermark)` 仅折叠增量部分，追加写入 `<dataDirectory>/cache/transcripts/<threadId>.turns.jsonl` 并更新索引与水位后返回。
2. **大输出 Blob 管理与删除**：
   - 单轮工具输出 `> 1024` 字节时，正文写入 `<dataDirectory>/cache/transcripts/<threadId>.blobs/<sha256>.blob`（`0600`），Turn JSON 内仅保留前 1KB 预览与 `outputBlobRef`。
   - 当会话被删除、归档清理或缓存版本失效重建时，直接 `rm -rf <dataDirectory>/cache/transcripts/<threadId>.turns.jsonl <dataDirectory>/cache/transcripts/<threadId>.blobs/` 并删除 SQLite 对应行，保证零残留、零敏感数据泄漏。

---

## 5. 与 `@opencraft/host-recovery`（自动续跑）的状态协同矩阵

当子会话在执行中遇到引擎进程重启或崩溃时，Broker 按 `@opencraft/host-recovery` 的权威恢复状态决定动作：

| 子会话原生事件 | `@opencraft/host-recovery` 状态 | Broker 对子会话的状态投影 | 是否向父会话入队通知？ |
|---|---|---|---|
| 连接断开 / `turn/interrupted` | `continuing`（重试次数 1..3 内，正在自动续跑同一 `rootTurnId`） | `working (recovering)` | **否（严格抑制，防止父会话误判中断而重复派发或覆写）** |
| 自动续跑后正常完成 | `completed` | `done` | **是**（`outcome_kind = "completed"`，按 `rootTurnId` 唯一去重） |
| 自动续跑 3 次后仍中断 | `exhausted` | `failed` | **是**（`outcome_kind = "exhausted"`，通知父会话自动续跑已耗尽） |
| 续跑提交结果不明 | `unconfirmed` | `awaiting_attention` | **是**（`outcome_kind = "unconfirmed"`，提醒检查且禁止盲目重发） |
| 用户在 UI 点击停止 | 已撤销自动续跑 | `interrupted` | **是**（`outcome_kind = "interrupted_by_user"`，`hasDirectUserInput = 1`） |

---

## 6. 修订后的分阶段实施与验收计划

| 阶段 | 排期位置与依赖 | 核心交付物 | 验收与门禁判据 |
|---|---|---|---|
| **Stage 0（可先行落地）：打开会话只读解耦与可重建缓存** | **不依赖平滑升级改造**；与Token 统计共用同一个 Codex rollout 增量读取器 | 1. 拆开客户端点击会话的 `Read`（只读历史）与发消息时的 `Resume`（唤醒引擎）<br/>2. 在受管 `<dataDirectory>/cache/transcripts/` 实现 `.turns.jsonl` + `opencraft_turn_offset_index` + 水位追平与版本重建<br/>3. 实现单会话 `.blobs/` 冷热分离与删除联动 | • 服务端缓存命中读取耗时 P95 < 5ms；不唤醒引擎、不触发模型目录 RPC<br/>• **用户端体感指标**：点击 500+ 轮旧会话到首屏 10 轮 DOM 渲染完成 P95 < 150ms<br/>• 删缓存目录、改 `projection_schema_version`、模拟崩溃水位落后三场景均能从原生日志无损自动重建 |
| **Stage 1（Codex 已实现）：常驻宿主编排、自动续跑协同与多人权限** | 排在**执行连续性改造（拆 AppServer 常驻 + 自动续跑）**与**Token 统计（Token 改造）**之后 | 1. 扩展 `actor-collaboration.sqlite` 支持父子拓扑、持久 `waitTickets`、`parent_notification_batches` 与 `toolCallKey` 幂等回执<br/>2. 实现 Engine Host 侧工具调用断线重连重放（网关重启不中断工具）<br/>3. 对接 `@opencraft/host-recovery` 抑制续跑期假中断通知；对接有界用户委托校验跨会话权限，Agent 触发轮次记入 `sourceKind: "system"` | • 执行网关在子会话调用 `thread_tell / spawn` 期间重启，原 Turn 与工具调用一次完成、不报错、不重复创建<br/>• 子会话被杀触发自动续跑期间，父会话不收到假中断通知；续跑完成或 `exhausted` 后才收到唯一通知<br/>• 跨用户未授权 `tell` 返回 403；子会话自动轮次在 Token 看板归入“系统已知量” |
| **Stage 2（已实现）：UI 协作卡片三态分离与父子会话树** | 依赖 Stage 1 | 1. 改造 `@opencraft/chat-core` 的 `SubagentTimelineBlock`（分离 `toolCallStatus`、`deliveryStatus`、`childRuntimeStatus`）<br/>2. 侧边栏支持 `parentThreadId` 树状缩进与 `hidden` 会话过滤 | • `thread_wait` 超时返回 `settled: false` 时，UI 卡片保持 `working` 而非误标 `done`<br/>• 页面刷新后从控制账本与缓存精确恢复卡片状态 |
| **Stage 3：3+1 独立宿主驱动统一接入（Pi / DSH-ACP / Claude）** | 依赖 Stage 1 及独立 Pi/DSH Host；源码已接入，各部署独立验收 | 1. 在独立 Pi Host、独立 DSH Host（`--profile acp`，保留多代排空升级）、Claude/ACP Host 接入统一 `AgentDriverContract`<br/>2. 验证跨异构引擎父子派发与双向通信 | • Codex、DSH(ACP)、Pi 跨引擎互发 `spawn / tell` 全链路通过，且日常重启网关不中断任一引擎正在运行的任务 |


### Stage 1 已实现边界

Codex 的独立 APP Host 持有真实 Native 连接，Gateway 通过稳定 callback lane 在
15 秒窗口内重连并重放同一未决工具调用；普通 `turn/start` 等 mutation 不自动重发。
持久控制账本负责工具回执、等待、通知、有界委托和精确输入来源，恢复终态按原
`rootTurnId` 对账。普通新 root Thread 跟默认代，受信委托子创建跟 source Thread
的实际代，并由唯一 registry 校验 incarnation 与退休 fence。

Native 0.162 只在创建 Thread 时接收动态工具，因此四个编排工具注册到新 Thread；
既有 Thread 保留原工具集。旧 APP 继续按实际能力工作，不能仅凭 Gateway 已升级
宣称支持 callback 重放。UI 三态投影与父子树已在 Stage 2 实现；Stage 3 通过统一契约接入独立 Pi/DSH-ACP/Claude Host，各宿主需单独验收。


### Stage 2 presentation refinement

The three authority axes stay separate in the ledger and timeline. Collapsed
headlines and individual dispatches show one derived status; a dispatch tooltip
retains tool, delivery and child details. Failures take precedence, followed by
interruption, required attention, active work, unknown and confirmed completion.
Pending delivery remains active. A completed call or a timed-out wait never
proves child completion. Groups use the latest child projection and retain
failed calls, including creations without a child ID.
