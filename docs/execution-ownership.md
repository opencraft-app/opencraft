# 会话、执行运行时与能力租约所有权

本设计适用于 OpenCraft 的会话执行边界。DSH 是首个具体实现；其他引擎通过自己的 adapter 实现相同语义，不必采用 DSH 的 Agent 对象或私有 bridge。

会话存在、历史可读、运行实例已加载、工具访问权有效、某轮正在执行是不同事实。不得用一个 `ready` 或 `loading` 同时表达它们。

身份与协作的上位原则见[原生主体与 Hub 协作设计纲领](architecture/actor-collaboration.md)：人类与持久 Agent/Bot/Session 都是主体，权限大小不决定主体性。本文继续规定执行对象、连接与租约的所有权；Runtime 的执行所有权不替代 Session 的主体身份。目标设计中的身份准入、Channel 与跨 Hub 授权仍待实现。

## Client / Hub / Server 拓扑

当前连接与执行契约的协议参与者是 Client、Hub 与 Server，不是 Renderer、Host 与引擎；此拓扑不要求在产品主体模型中再建立一个“逻辑协作 Server”：

```text
Client ── ClientAttachment ── Hub ── ServerAttachment ── Server
                               │
                               └── HubLink ── Hub
```

- Client 是有身份和 incarnation 的交互参与者。一个 Client 可以承载零个或多个
  Renderer；Renderer 只是 Electron、静态 Web、React Native 或其他呈现机制，
  不进入 Thread、Server 或租约的持久身份。
- Hub 是具有自身身份的逻辑网络节点，Endpoint 是其具体接入地址；在此契约中承担目录、接入鉴权、路由、订阅、扇出和租约边界。Hub 与租户/项目作用域独立，资源所属权威仍复核动作权限。tenant 是 attachment
  与 route 的必填作用域，不从 socket、Renderer 或默认账号猜测。
  这是契约要求；现有类型或 lease 路由本身不能证明完整的 Actor 准入或多租户隔离已经实现。
- Server 是 Thread、历史、执行状态与能力状态的权威。Server 可以同时注册到多个
  Hub；Client 也可以同时连接多个 Hub。双方通过 attachment 形成多对多关系，
  不互存一个单值对端 ID。
- Host 是 Server 的部署与资源载体，拥有进程、文件、PTY 和引擎实例；更换 Host
  不改变 Server 或 Thread 身份。当前代码中的 `hostId` 仍压缩了 transport route、
  Server namespace 与 Host placement，迁移期只能在
  `legacyDirectServerProjectionFromHost()` 这一处按一对一直连拓扑投影。

同一 Server 经不同 Hub 可达仍是同一个 Server；Thread 的稳定身份是
`(serverId, threadId)`，Hub route、tenant authorization、Host placement 和连接健康
均为正交事实。级联 Hub 逐跳验证授权并携带 route epoch、幂等执行键和有界 hop
信息；必须拒绝环路、旧 epoch、跨 tenant 帧与重复执行。

Hub 可经直连、中继等方式级联成更大的网络，不要求全互联、唯一中心或固定父子树；这是目标拓扑，不表示现有 HubLink 类型已实现中继协议。中继只改变可达路径，不隐式授予身份、租户成员关系或资源权限；断链及路由切换不删除目标状态，未知执行结果须先查询对账，不能换一条路盲目重发。

## 对象与唯一所有者

| 对象 | 唯一 Owner | 身份与寿命 |
|---|---|---|
| Draft | Client 草稿服务 | 本地输入意图；不是 Server Thread |
| Thread 与产品目录 | Server 的 ThreadLifecycle/ThreadCatalog | `(serverId, threadId)`；换 Hub、Renderer 或 Host 后仍保留 |
| 历史 | 对应引擎的持久化服务 | 原生日志是历史真源；目录、Replica 和 UI 不另存权威副本 |
| 引擎运行实例 | Host 的引擎 adapter | DSH Agent 是内存执行对象，可加载、空闲保留、卸载 |
| Client/Server attachment | Hub | 绑定 tenant、lease 与 incarnation；可撤销、可多对多 |
| Capability 声明与访问租约 | Server capability broker | 绑定 Thread 和具体 Client attachment；可撤销 |
| 引擎内工具挂载 | 引擎插件 | 绑定当前 native Agent 实例；不等于访问权限本身 |
| Turn 执行权 | Host execution authority | 连接 owner、执行 epoch、Turn 身份；直到明确终态 |
| 人类待处理交互 | Host shared interactions + native source | Thread 范围快照与版本、原生请求身份、唯一答复准入；全部已接纳订阅者可见 |
| View 与导航 | Client Shell | 页面呈现、焦点、订阅；Renderer 不是协议 owner |

同一个 Thread 可以存在且可读取，但没有活跃引擎实例。关闭 View 不等于停止 Turn；连接撤销不等于删除历史。原生 preset 属于引擎 composition，外部 Browser/Terminal/Connector 工具通过可撤销 scope 接入，不能把客户端回调权限固化进 preset。

### Human answer attempt ownership

Within a shared human request, one answer object owns each admitted write.
Producer `pending` replay revokes that object independently of the stable request
Entry or textual submission ID. A failing writer must match both captured Entry
and answer before publishing `unconfirmed`; its own caller still receives the
original failure. Route replay retaining `responding` does not revoke the answer.
External validation precedes admission and requires another Entry/state check on
return, because validation may admit a peer or retire the request synchronously.
Native resolution remains the authority for removing the shared request.

### Logical channel response ownership

AppHost physical Host generations may carry several admitted logical leases in
one renderer connection. A targeted frame retains its validated `leaseId` in
the Hub-to-client envelope after the internal logical Client marker is removed.
The browser dispatches that frame only to the owning lease at its acknowledged
Host generation. A peer's frame or status cannot grant a channel a generation;
only its own connect acknowledgement can. Retired lease replies are discarded.
In logical-routing mode requests and responses without an owner are dropped;
only untargeted notifications may fan out to admitted subscribers.

Default JSON-RPC IDs include a client-instance prefix and a monotonic sequence.
That prefix is local protocol correlation, not a durable Client, Server or
Thread identity. Routing isolation must still hold when two leases deliberately
reuse a request ID. AppHost protocol version 2 requires the lease-aware routing semantics; mismatched
version-1 peers fail the handshake instead of silently losing isolation. The
lease field is absent only for broadcast notifications or non-logical direct
adapters. Older renderers need refresh; unique RPC IDs do not substitute for
targeted notification/request ownership.

The AppHost protocol package exposes a JavaScript-only `./version` entry for Node delivery/readiness scripts; these scripts must not load the TypeScript domain entry or depend on a TypeScript resolver. The domain entry re-exports the same constant.

Machine discovery is a cold control-plane read. Daemon and headless local DSH
and Codex routes share the deployment's persisted machine identity. Headless
SSH routes return unsupported identity without dialing SSH or allocating the
native engine; they never return the Hub's identity as the remote machine.
The deferred adapter forwards trusted submission context without alteration.

Initial conversation presentation precedes remote readiness. Navigation owns
an activation epoch and distinguishes connection preparation failure from Thread
acquisition failure. A connection-stage failure may resume the same initial
intent once the runtime becomes ready, at most once per readiness transition.
New navigation, cancellation and disposal retire that intent. Thread-domain
rejection remains explicit; readiness does not retry it or replay Turn writes.
Scope/View commitment stays in the conversation activation owner, not the
runtime reconnect loop.

## Workspace 解析与 Projectless Thread

Workspace 是执行 Host 的本地资源身份，不属于 Client 或 Renderer。新 Draft 没有选择 Project 时仍可提交；Local Host 在用户 Home 下的 `OpenCraft/` 根目录为该 Thread 创建独享的 `thread-<id>/`，再把确定的 `cwd` 与 `runtimeWorkspaceRoots` 交给引擎。macOS 和 Windows 分别由 Host 的 `homedir()` 投影为原生绝对路径，Client 不构造 `/Users/<name>` 或 `C:\\Users\\<name>`。

显式 Project 不得静默降级为 Projectless。Host 在引擎创建前解析、规范化并验证 Project cwd 与 sandbox roots；缺失、非目录、相对路径和不可访问分别返回稳定的 Workspace fault。Projectless 目录只在 Thread 创建失败且仍为空时回收；一旦成功，它是用户工作空间而不是运行时临时目录，关闭 View、卸载 Agent 或退出应用都不得删除。

## Readiness 的含义

| 条件 | 可以证明 | 不能证明 |
|---|---|---|
| Host/AppServer ready | 协议连接已初始化 | 某 Thread 已恢复或可执行 |
| History authoritative | 首屏历史有服务端基线 | Agent 已加载、工具已挂载 |
| Capability declaration accepted | Host 接受当前客户端的声明 | Engine 已完整挂载；冷态允许 deferred |
| Engine tools mounted | 当前实例具有所需工具集合 | 旧客户端仍获授权、模型或权限仍匹配 |
| Turn admission accepted | Host 接受本轮执行 | 推理或工具操作已成功完成 |

`AgentRuntimeDirectory.ensureReady()` 当前是 Host 连接边界，不能用其名字推导为 Thread 执行实例就绪。Renderer 的 `capabilityDeclarationAccepted` 可以接受冷态 deferred；真正执行前的完整挂载检查属于 Host。

## 新建、恢复与执行

新建路径：

1. Host 验证声明并为本次创建分配 native session ID。
2. 引擎创建 Agent，在 native setup 内挂载 preset 和首次 Host capability scope。
3. setup 失败由引擎创建生命周期收尾，不能发布半装配的 Session。
4. Host 确认客户端仍有效，绑定 broker 声明，确认挂载结果。
5. 准备成功后提交产品目录、订阅及 `thread/started`。
6. 第一轮输入通过执行准入后进入引擎。

上述目录提交顺序只适用于 `thread/start` 已经产生可恢复持久身份的
Host。Codex AppServer 的新 Thread 在首轮接纳前可能只有内存身份、writer
lock 与 shell snapshot，尚无 rollout；此时 Renderer 若先将 Draft 升级为
Thread，激活阶段的 `thread/resume` 会与首轮提交竞态并得到
`no rollout found`。这类 Host 必须声明
`opencraft/thread-start-durability: { durableAfter: "first-turn-accepted" }`：
Workbench 在同一 Draft 提交事务内依次完成 `thread/start` 与首个
`turn/start`，收到含 Turn ID 的回执后才导航升级；确定性失败保留原 Draft
及原输入。该能力不声称两个 RPC 是数据库原子事务，也不允许在未知网络
结果后自动重发。

恢复已有会话时，历史读取独立完成并呈现；capability 声明可在后台准备。失败不清空已恢复历史、不删除已有 Thread。用户执行时重试所需准备，并在提交位置呈现失败。

用户命令的 metadata-only `activate` 与只读历史恢复分别持有等待；旧激活 ACK 不阻塞新的 readonly baseline。激活 ACK 只提交 execution/stream 字段，保留当前历史 source、cursor 和其间观测到的 live settings。准备 await 后重新核对当前 baseline，并在首个写入发送前复核本地资格；创建/fork 已确认后的失败属于部分效果，不能归类为全未发送。完整 historical Resume 与 legacy message-window 保留原组合契约。详见[恢复契约](architecture/platform/connection-recovery-contract.md#execution-activation-and-current-presentation)。

执行准入必须保证检查与提交之间绑定没有变化。Capability 替换和执行准入复用 Host 的 ThreadLifecycle 队列；引擎执行权继续由 execution authority 管理。不能只在 `await validate` 前检查“当前没有执行”，随后无条件卸载工具。

停止任务、审批回复、撤销与队列删除不等待 capability 初始化；仍需验证各自对应的 Thread、Turn、请求身份和权限。控制操作应在故障时保持可达。

## 只读历史与可重建缓存

打开历史调用 `thread/read`，读取正文、订阅呈现与取得执行权分开。只有发送、继续或其他明确执行操作才进入 Resume/准入；读取缓存不创建 Agent、Pi Harness 或其他执行 owner，不获取客户端工具租约。独立 Host 的网关 attachment 只连接已有 Host；缺失或不健康时拒绝连接，不由历史读取或网关启动补起引擎进程。

原生日志始终是正文与工具输出的唯一真源。共享 [TranscriptReadCache](../packages/native-history-node/src/transcript-read-cache.ts) 在受管 `dataDirectory/cache/` 中维护可丢弃的 `transcript-index.sqlite` 与 `transcripts/<threadId>.turns.jsonl`；索引绑定投影 schema、原生来源身份与水位、分页 epoch 和 Turn 字节偏移。大于 1 KiB 的工具正文保存到会话自己的内容寻址 Blob，读取所需 Turn 时恢复原始字段类型。元数据每次从当前 Host 重新验证；缓存命中不能跳过 native HOME、路由代次或来源替换的检查。

| 原生来源 | 水位与追平方式 | 读取不取得的资源 |
|---|---|---|
| Codex rollout | 受信 HOME 中的文件身份、大小与时间戳；与 Token 读取共用完整 JSONL 行的字节游标，定位脏 Turn 后通过原生规范投影追平后缀 | Native Thread 执行权、Resume、模型目录 RPC |
| Pi SQLite | 数据库及 WAL 的文件身份、大小与内容修改时间；水位变化时从一致的只读快照取得原生规范投影 | Pi Harness、native writer、执行 owner |
| DSH snapshot | 包含逻辑 Thread 全部原生路由代次的日志文件水位及路由指纹；持有该来源的 Host 校验代次后读取规范投影 | Agent 创建、prepare、Resume；既有只读元数据或历史查询不激活 Agent |

Pi/DSH 的 snapshot port 可能仍需读取完整原生逻辑快照，不声称其数据库字节支持 JSONL 增量。缓存对比有序 Turn 前缀，只更新变化的未完成尾轮及新增 Turn 的偏移、正文和 Blob；这两类变化保留既有序号与分页 epoch，运行中新轮次不会使用户正在翻阅的旧页失效。SQLite WAL checkpoint 或截短本身也不改变逻辑历史的 epoch。历史前缀改写、删轮或重排、原生来源身份/路径/路由变更、schema 失效或派生文件丢失时重建并更换 epoch；旧游标明确要求重新加载，不能继续解释为另一版历史的偏移。SQLite 只读连接可能改变 WAL 的 ctime，因此 snapshot 水位不以该元数据变化制造内容失效；Codex 保留自己的字节追加判断。

删缓存目录、索引损坏或正文/Blob 校验失败只能重建派生数据，不能修改或删除原生日志。归档或删除的缓存清理与迟到读取通过会话级失效代次协调；清理同时删除索引行及该会话的正文与 Blob。无可用文件来源的临时会话或原生 backend 保留原有只读协议兼容。回归入口为 [原生 snapshot 缓存](../tests/protocol/native-transcript-snapshot-cache.test.ts)、[Codex 缓存](../tests/protocol/transcript-read-cache.test.ts)及 [DSH 冷态来源定位](../tests/execution/dsh-thread-engine.test.mjs)；主服 Host 是否已加载这些能力仍须核对实际版本、进程与行为。

### 历史读取的等待与取消

`TranscriptReadCache` 的正序和倒序分页使用同一偏移索引，游标分别带方向与 epoch。
没有缓存游标的兼容请求仍遵循原生协议；旧游标不能按新的偏移格式重新解释。
冷缓存或 snapshot 水位变化仍可能需要完整投影，一次多页重建复用同一一致快照，
热缓存命中不重复创建 SQLite 快照。

每个缓存读取默认有 30 秒总等待预算，包含排队、元数据和原生分页；取消信号向原生
读端传播。Pi 的快照备份逐批检查预算，扫描页间让出事件循环，退出后清理临时文件。
单次同步 SQLite 操作不能被 JavaScript 信号抢占，取消在批次/分页边界生效。
取消一个排队读者只结束其等待，不解除前任真实任务的串行屏障；迟到原生响应不能
继续发布过期结果。

Pi 显示读取不进入执行 mutation 队列，慢快照不能阻塞已知 Turn 的 Stop 或执行准入。
Pi/Codex 的客户端断开撤销自己的历史读者，不取消后台 Turn/Goal，不杀命令进程。
shell 工作区、深度、输出、运行/空闲时限及命令 watchdog 由执行引擎/沙箱持有。

## Interaction 响应与重连对账

Codex 与 DSH 的人类交互通过 `opencraft/shared-interactions` v1 协商。审批、权限、
提问、MCP elicitation 和已指定的动态表单工具使用同一 Host coordinator；普通可执行
工具保持唯一执行路由。Host 用 `opencraft/interactions/changed` 广播 Thread 快照，
客户端可通过 `opencraft/interactions/read` 补基线。快照带 producer epoch、单调 revision、
稳定请求身份与 `pending/responding/unconfirmed`；客户端拒绝迟到版本和已退役 producer。
收到新快照无需刷新页面或重新取得工具执行租约。

全部已初始化、成功订阅 Thread 的客户端可观察；提交 `opencraft/interactions/respond`
是当前实例访问权下的显式命令，服务端在写出前重验客户端代次、订阅及可信资源租约。
历史 watch 不会自动启动 Turn，但可显式回答已存在的人类请求。没有 Thread 订阅的
连接不能读取或回答。UI 没有 response port 时仍为只读，不推导新的角色或跨实例权限。

Host 在广播 responding 前同步裁决唯一回答。重复或相反回答不再次写原生通道；
submission ID 复用不同回答会拒绝。写入成功只代表已提交，卡片保留到原生
`serverRequest/resolved` 或对应 Turn 明确终态。写出失败保留 unconfirmed，不能当作
未提交重新批准；源重放才可证明 pending。原生 request ID 类型、来源 lifetime 与
Turn 保持隔离，终结后复用 wire ID 创建新请求，不复活旧回答。

Codex APP callback lane 保留人类请求，网关离线期间的新请求也留存；网关重连初始化
后重放原身份与提交阶段，不自动回答、超时取消或重新执行已提交响应。该保障跨 Gateway
生命周期，尚不声称跨 APP/Native 进程重启的永久日志；原生恢复仍须重新建立真实 pending。
生产升级必须分别核验 Gateway、router 与 APP payload，不能只用 Web sourceRevision
声称旧 APP 已热更新。

协商新协议的页面只消费被动快照，避免多个原始 RPC handler 同时作答。旧客户端保留
原始请求兼容路由，仍由 Host 裁决唯一回答。旧客户端 response delivery ledger 只在旧协议
路径重放 exact response；它不拥有共享真相或新的原生执行权。

原生明确报告 waitingOnApproval / waitingOnUserInput 而没有请求细节时，界面呈现
“正在恢复待处理请求”，同步当前状态后至多为当前连接/Turn 恢复一次原会话；这不创建
Turn。恢复失败显示未能恢复的明确状态，不长期停在 Thinking。普通静默不能推断等待原因。

同一 Codex stdio 连接上的原生 Thread 订阅属于 Host，不属于任何单个 logical
Client。Client 的 `thread/unsubscribe` 只撤销其读者身份；pending `thread/resume`
在回执前是临时读者，取消或断线同步撤销，旧 Client incarnation 的回复既不能
恢复读者/答复权，也不能投递给同 ID 的新连接。Host 的已接纳 Turn、未结
队列和待答 server request 独立要求保留原生事件流；只有无读者、无这些需求且
原生 Thread 空闲时才能回收物理订阅。回收与新原生工作按 Thread 串行化。

## 撤销、重连与释放

断线首先同步撤销客户端 owner 与执行权限，再异步清理引擎挂载和待处理调用。所有在途操作在提交前重新验证 owner；旧请求不能恢复已撤销租约。

Logical client incarnation 与 physical socket、客户端提供的 logical ID 分开。同一物理连接重新建立同名 logical client 时使用新的 owner 身份；旧实例的清理不能删除新实例。

工具挂载和完整 Agent release 在引擎侧使用同一 native session 操作队列。只把 release 后的 unregister 放进队列不够，Agent dispose 本身也必须受协调。Host 的旧 owner 清理不得撤销后继 owner 的能力。

注销失败属于真实失败，不能静默当作成功继续替换。连接清理可以尽力完成，但权威访问权限必须已经撤销。关闭插件时先停止接受新的生命周期操作，再等待既有操作收尾并释放资源。

## 不变量

| ID | 约束 |
|---|---|
| EXO-01 | 目录查询、历史读取和 View 呈现不隐式获得 Turn 执行权 |
| EXO-02 | Thread 持久身份、native runtime 实例、连接 incarnation 和执行 epoch 不混用 |
| EXO-03 | 声明接受、冷态 deferred 与完整挂载是不同结果 |
| EXO-04 | Capability 替换与执行准入共用 Thread 协调边界，校验到提交之间不可被替换 |
| EXO-05 | Owner 先撤销后清理；所有异步完成均受生命周期有效性约束 |
| EXO-06 | 停止、审批回复和撤销不依赖重新准备工具成功 |
| EXO-07 | 新建产品目录不早于准备成功发布；已有持久历史不得作为挂载失败的补偿删除 |
| EXO-08 | 相同工具挂载幂等；完整挂载、释放和清理必须遵循同一资源顺序 |
| EXO-09 | Bridge 只返回允许列表中的错误码；截断任意异常文字不构成脱敏 |
| EXO-10 | 预热复用正常准备流程，不改变身份、权限或持久化语义 |
| EXO-11 | 未选择 Project 时由 Host 创建 Projectless Workspace；Renderer 不猜 Home，显式 Project 失败不得静默换目录 |
| EXO-12 | Client、Hub、Server 是顶层协议身份；Renderer 与 Host 只分别描述呈现机制和部署载体 |
| EXO-13 | Hub 拥有其 attachment/route 关系；tenant 是独立授权作用域，不由 Hub/Endpoint 推导，既有 attachment/route 的 tenant、lease、incarnation/epoch 校验要求保留 |
| EXO-14 | Server 身份不随 Hub route 或 Host placement 改变；相同 Server 经多条 route 不复制 Thread |
| EXO-15 | 级联 Hub 拒绝环路、旧 route epoch、跨 tenant 帧和重复执行；断开 route 不删除 Server 状态 |
| EXO-16 | Interaction 的 Server 真相与 Client delivery ledger 分离；点击不等于送达，重连只可回放同一 identity 的 exact response |
| EXO-17 | Renderer/Client attachment 消失只撤销该连接的路由与访问权；进程级 Host transport 和已接纳 Turn 不因最后一个页面关闭而结束。服务进程关闭与显式 Stop 仍可结束执行。 |

## 已有复用与 warm 的边界

当前已存在 Host 连接 single-flight、DSH session activation single-flight、Thread binding 复用，以及最后订阅离开后的默认 30 分钟延迟卸载。这些机制应继续由现有 owner 管理。

当前没有预创建 Thread reservation 或 hover 后提前 loadSession 的产品流程。若引入预热，应先证明耗时所在，再定义目标配置指纹、连接/引擎代次、单次消费、TTL 和失效释放。预热失败允许正式请求重试；其 TTL 不得回收其他消费者或活动 Turn 持有的资源。不要为预热再创建第二套 Thread 或 Agent 权威。

## 实现与验证入口

- Host 装配：[main.ts](../apps/local-agent-host/src/main.ts)。
- 目录/订阅/协调：[ThreadLifecycle](../apps/local-agent-host/src/thread-lifecycle.ts)。
- 客户端租约：[DshCapabilityBroker](../apps/local-agent-host/src/dsh-capability-broker.ts)。
- 执行权：[DshExecutionAuthority](../apps/local-agent-host/src/dsh-execution-authority.ts)。
- 引擎生命周期：[thread engine](../apps/local-agent-host/src/dsh-thread-engine.mjs)、[capability plugin](../apps/local-agent-host/src/dsh-capability-plugin.mjs)。
- Renderer 历史和声明准备：[Workbench runtime](../packages/workbench-runtime/src/appserver-runtime.ts)。

回归必须覆盖：注册悬挂时历史可读且停止可达；校验期间断线后迟到提交被拒绝；替换与 Turn 准入交错；同 socket logical client 重建；并发重复挂载；setup 挂载失败后原生列表无新 Session；释放与挂载交错；错误正文包含敏感内容仍不回传。

模型测试从 `tests/chat/thread-lifecycle.test.ts`、`tests/execution/dsh-capability-broker.test.ts`、`tests/execution/dsh-execution-authority.test.ts`、`tests/chat/chat-workbench-draft.test.ts` 进入；真实引擎验证使用 `scripts/smoke/execution/smoke-dsh-capability-plugin.ts`。这些是验收范围，不能把测试入口存在当成每种交错已完整验证。

## 尚未闭合的交付边界

Native setup 回滚、Host 目录提交和跨进程回执不是一个数据库事务。当前 Host 预分配 native session ID，使请求超时后的运行资源释放可以定位原创建；这仍不等于跨重启幂等或 exactly-once 创建。

创建已持久化但响应丢失时，后续还需稳定 operation ID、结果查询和重试复用契约。补偿不能以删除持久日志代替确认。工具挂载的端到端 lease revision/CAS 以及超时取消传播也不能仅凭串行队列推定已经实现。

本设计描述所有权和目标不变量；当前测试、全量 gate、签名包与对方机器的验收证据分别记录在下游产品工作区的整改记录（不在本仓库）。源码修改不等于旧分发包已经更新。

## Conversation schedules

A conversation schedule is owned by the long-lived Server-side Host service,
not by a View, renderer connection, engine timer API or creator's expired login
context. `@opencraft/host-schedules` exposes `opencraft/conversation-schedules`
version 1 and `opencraft/schedules/{list,read,save,action}` on local Codex and DSH
Hosts with an attached schedule owner. The capability is explicit; accepting a
method name alone is not evidence of background scheduling support. Managed
Headless initializes that owner at startup when connected to the native core,
so existing schedules recover before any browser connects. Other deployment
modes must initialize their Host owner before schedules can run.

`ConversationSchedules` owns a managed per-Host `conversation-schedules.sqlite`
with plans and occurrence history. Each conversation has one current plan,
revision-checked mutations, an absolute first execution instant, optional fixed
minute interval and an IANA display time zone. Intervals measure elapsed time;
they are not calendar cron expressions or promises of local wall-clock daily
execution across daylight-saving changes. The existing conversation menu is
the only creation entry. Editing and background reads do not replace a form's
captured revision or unsaved draft.

The editor lists the Host's verified permission profiles and stores the selected
profile on the plan. An omitted selection retains conversation defaults; legacy
plans are never silently promoted to Full access. Each occurrence snapshots its
selection before admission. Codex resolves it to an allowed native profile before
claiming the durable queue row, including after restart; DSH passes it through
its existing permission authority. Changing a plan does not change an admitted
occurrence. The Host rejects unknown or disabled profile selections on save,
and the engine remains authoritative at execution time.

`ScheduleExecutionPort` separates scheduling from engine admission. An adapter
validates the target, attempts non-interrupting submission using the occurrence
ID, and independently observes execution outcome. Codex, DSH and Pi subscribe to
native completion events carrying only thread identity, turn identity and outcome.
An early event is retained only for the unfinished occurrence and must match its
acknowledged native turn before settling it; an older inspection cannot overwrite
native completion. Four per-conversation flights bound active admission/inspection.
A blocked conversation does not hold the tick or completion handling of peers.
The per-conversation flight owns a 30-second transient failure cooldown covering
its entire advance, including initial occurrence persistence and expiry writes.
Native completion is retained but cannot clear a failed persistence cooldown;
only an ordinary observation deadline can be cleared by a native event.
Persistence failure never authorizes resubmission.
Closing unsubscribes first, drains active work, then releases storage.

Codex reuses its durable queue and acknowledged turn ID; queue delivery is not
completion. On restart or missed events it queries bounded `notLoaded` turn-summary
pages, never historical items. DSH persists the occurrence input identity in its
execution journal before native submission and inspects that journal; human,
queued and armed-Goal work defer admission. Pi uses native durable submissions
queried by the same occurrence request ID, without projecting a transcript. Its
submission and pause/archive fences share the normal per-thread admission owner.
Pi only accepts its verified Full access profile and durable unarchived targets;
it does not borrow a browser's tool lease for unattended execution. An unknown
receipt never authorizes resending. With native event support, running-state
fallback inspection is at most once per minute, plus restart/event wakeup; legacy
ports retain their existing fallback interval. Hermes must provide an equivalent
adapter and capability declaration before exposing schedules. A browser bridge
must not own unattended schedules.

Busy conversations and unresolved interactions defer admission. One unfinished
occurrence blocks further occurrences for that plan; missed intervals coalesce
to one execution and the next future interval. The intent is persisted before
submission. Restart repeats the same occurrence ID against an idempotent queue,
not a fresh send. Unknown delivery remains blocked and is never automatically
replayed. Explicit user review stops tracking that uncertain run and pauses the
plan; it does not infer success or resend. Queue-level deduplication is not an
exactly-once guarantee across engine admission and process failure.

Pause/delete stop future admissions and waiting occurrences; already submitted
execution can continue and is stopped through the conversation's normal control.
Shutdown stops the timer, waits for the in-flight tick, then releases storage.
Failures use safe diagnostics without prompt, credentials or raw upstream errors;
mutation failures appear through Workbench's non-blocking notice owner.

Schedule management inherits the currently admitted shared Host authority. Creator
identity is audit provenance only, not an authorization grant, credential cache or
impersonation mechanism. This feature does not establish per-user tenant isolation.
Scheduled prompts carry explicit scheduled-task provenance rather than fabricated
employee sender metadata.

### Schedule catalog projection

Hosts declaring `opencraft/conversation-schedules.summary=true` expose
`opencraft/schedules/list`, returning only thread ID, plan status, next-run time
and whether acceptance needs review. Prompts, creators and execution history stay
out of this list. The owner emits `opencraft/schedules/changed` after committed
semantic summary changes, not on busy polling or inspection timestamps.
Clients query once per admitted Host/profile/authorization scope, refresh after
invalidation, reconnect or background catch-up, and retain same-scope cached
facts through transient disconnection. Late results from replaced runtimes or
revoked scopes cannot publish. Rows never issue per-thread schedule reads.
An active or paused plan adds an independent neutral clock; settled one-shots
and deleted plans disappear unless an unknown occurrence still needs review.
The marker has no effect on activity grouping, unread or execution state.

## 主体协作输入

Headless 的主体协作服务将执行请求交给现有 OpenCraftHostQueue，以稳定 clientUserMessageId 查询回执和恢复，不拥有第二个运行领取者。queue 与 steer 分别授权，steer 固定 expectedTurnId；Actor 代次、实例准入、目标 grant 和运行绑定在入队及领取前复核。协作提交不等于任务完成，结果不明先查询，绝不自动换成另一种执行模式。完整契约见[主体协作接口](actor-collaboration-api.md)。

## Optional execution engines in one Host

Headless can enable `--engines dsh,pi` (default engine DSH), or `--engines pi`
without allocating DSH. `--default-engine pi` changes new-conversation defaults;
restoring an existing conversation always uses its native engine. Engine identity
is distinct from machine identity and model provider. The model menu groups the
available models by engine in both standalone and embedded model pickers; a live thread receives only its own engine's catalog. Engine/provider headings remain visible inside each Agent group, so identical model names remain distinguishable.
The `runtime/engines/list` endpoint describes the enabled engine registry.

`plugins/pi-engine` embeds the pinned experimental `pi-durable` 1.3.0 SDK in the
server execution owner. It does not start the legacy Pi CLI RPC process. The owner
holds each session's SQLite database, writer lock, scheduler and model/tool environment.
Pi always has one execution cwd, but selecting a workspace is optional. An absent,
null or empty `runtimeWorkspaceRoots` inherits the configured Host cwd for a new
Thread and the retained session cwd on Resume/Turn start. A non-empty roots list
must contain one absolute path equal to that cwd; path normalization also removes
equivalent trailing separators. Empty roots do not clear or replace a session's
workspace, and invalid/multiple roots remain explicit errors.

Pi exposes the shared durable queue and atomic queue-to-steer APIs. Pending message
custody lives in the native conversation's `opencraft.queue` document; native
submissions remain the sole execution receipts. Queue updates, removal and exact
reordering are native commits. Atomic queued steer checks the target live run,
removes custody and admits native steering in one transaction. A stale target or
already-dispatched input is rejected without changing its destination. Stable
client identities reconcile admission after lost ACKs or owner restart; a discarded
message retains a native tombstone and cannot reappear on retry. Reading history or
the queue does not start a dormant execution owner.

A single per-thread dispatcher claims pending input only when idle. A native receipt
retires stale claimed custody even if its ACK was lost. Without such a receipt, a
failed send pauses the queue for an explicit retry. Stop pauses pending messages
before aborting the active Turn; queued messages survive restart and can be edited,
removed or explicitly resumed. Successful new direct input resumes normal queue
processing. Temporary threads cannot own durable queues.

The headless Pi adapter includes the pinned `pi-interactive-shell` extension in a
separate process per active conversation. `interactive_shell` launches dispatch or
structured monitor sessions, returns their handles, accepts terminal input, reads
bounded output and stops sessions. The CLI's foreground TUI overlays and slash
commands are unavailable; requesting them yields an explicit error. The worker's
profile, logs and session handles are isolated by conversation, and are not client
installable extensions or an additional model runtime.

`bash` preserves the native command and timeout-in-seconds input and adds optional
`yield_time_ms` (0–10000, default 1000). A command that exits in this window returns
its result inline. Otherwise it returns a background session handle and lets the
native agent proceed, allowing steering at the next native boundary while the
command continues. Background dispatch does not terminate merely because output
is quiet. Use `interactive_shell` to query, send input, or kill the returned handle.
At most eight commands run per conversation; result history retains up to forty
records with bounded output. A handle from another conversation cannot be used.

Native `opencraft.piShell` documents hold session receipts and retained results.
Completed commands and monitor events enter the native submission kernel using
stable identities and system provenance. Admission, stop gating and notification
receipts share a transaction. A completion starts an idle native run or joins the
follow-up inbox of a busy run; it never invents a human message in the timeline.
Short commands already returned inline do not trigger a second model continuation.
Stop pauses delivery before killing shell processes and aborting the native run;
this also works after the original agent response has already settled. Closing a
session shuts down its isolated extension process, including retained CLI timers.
On owner restart, running PTYs are reported interrupted and never re-executed;
retained state remains queryable. Only native durable agent tasks resume normally.

Pi publishes native idle status when a Turn settles and supports `turn/steer`.
`expectedTurnId` is checked against the native live run in the admission transaction.
Steers are consumed at native tool/final boundaries; current model requests and
tools continue under their original owner. Client message identity deduplicates
retries, including after restart and completion, and rejects conflicting content.
Original input blocks, context and the target Turn are preserved in native records;
a display-only admission entry retains them when stop withdraws an unplaced input.
All corresponding native submissions project into the same OpenCraft Turn.

Native steering projection distinguishes inbox admission (`pending`), actual
context placement (`accepted`) and withdrawal before placement (`cancelled`). The
shared timeline defers to that native state rather than treating a transport ACK
as consumption. The existing message status slot presents these states; queue and
steer remain separate available actions, preserving the user's sending preference.
The browser outbox still handles disconnected custody and never replays an unknown
outcome as a new native execution.
Closing the owner suspends work; explicit stop aborts it. On startup the owner checks
recovery hints against native durable records and resumes unfinished inputs. Native
entries, submissions and committed partials are the history authority; the adjacent
JSON index contains routing and display metadata only. Different engines do not
resume or translate one another's ledgers.

Pi uses deployment-local `pi/auth.json` and `pi/models.json` under the server data
directory, in the coding-agent formats. These are distinct from DSH connection
settings. Do not copy credentials into thread metadata. The integration accepts text, local file references, explicitly selected skill files,
and base64/local images when the selected model accepts images, alongside native coding
tools and client-declared platform tools. Audio and remote-image/file-ID inputs are rejected.
Additional context preserves its source and application/untrusted classification inside
the submitted user context; it is never promoted to system instructions. Original input
blocks and client identity are atomically recorded in the native input entry, including
queued admission, rather than in a parallel message store. Platform tool
leases expire on client disconnect; they are not marked replay-safe, so recovery
cannot repeat an external side effect on that assumption. Workspace AGENTS.md files
are loaded by the coding-agent context loader. Workspace project IDs are retained as catalog metadata across restart; they do not enable project-specific runtime instructions or change the native cwd. The canonical Full access profile and equivalent never-approve/danger-full-access policy are accepted on creation, restore and turns; restricted/custom permission profiles are rejected before execution. Managed profile skills and alternative permission profiles are not yet
implemented by this provider. Schedules use the shared Host plan owner and native
Pi submission receipts; they do not introduce a second execution ledger. Native tools run with the execution owner's filesystem
and process permissions; this provider does not advertise a sandbox.

Engine registration is trusted server composition, not installable client code or
an authorization grant. Actor admission and Host access stay at the existing ingress.
The current registry composes the local DSH/Pi endpoint; Codex's existing endpoint
continues independently. Enabling this registry does not migrate Codex into it.

### Daemon gateway health observation

The daemon deployment profile retains one idle readiness IPC connection. Normal
health probes reuse it without allocating connections or initializing an engine.
Losing it immediately invalidates readiness; probes report unavailable and share
one background recovery attempt. Recovery replaces the storage summary with the
new connection's summary. A Core result is healthy only if that same readiness
connection still owns the observation after the await. Shutdown closes the
observer and rejects late recovery results. Headless deployment keeps its
independent Core/DSH health contract.

### Backend connection loss and client recovery

The multi-engine Host treats each frontend connection and its DSH backend as one
connection incarnation. Losing the backend revokes the frontend incarnation,
settles pending RPC and platform-tool leases, and closes the frontend with a
retryable service-restart close. Late target resolution and backend frames cannot
allocate or publish into a retired incarnation. The Host does not silently swap
backend sockets: DSH Thread attachments belong to the old physical connection.

Identical initialize and catalog reads may share an in-flight operation only
among logical clients on the same frontend connection. Its backend RPC and
cancellation belong to that connection. Independent frontend connections keep
independent reads, so closing one cannot fail another connection's handshake or
catalog. Completion or failure removes the in-flight entry; subsequent reads
start fresh. This sharing never applies to execution mutations.

The existing client connection owner reconnects and negotiates capabilities;
Thread recovery then issues Resume, restores its history boundary and reattaches
notifications before marking that Thread authoritative. Host readiness and Thread
authority remain separate. Recovery does not replay accepted execution requests.
When DSH is configured, its initialization failure rejects the Host handshake
instead of substituting Pi capabilities. Pi-only composition never allocates DSH.

This contract uses the current Host-wide connection unit: a DSH connection loss
also expires Pi client/tool leases on that frontend and briefly reconnects its
Pi conversations. It does not close either engine owner or restart its process.
Independent recovery of engines would require an explicit engine-generation
protocol; it is not implied by reconnecting an internal socket.

### Pi durable field and projection contract

Start, Resume and turn configuration share validation. Model and thinking, cwd and
developer instructions belong to native AgentDoc; base instructions use a native
conversation document rendered through a prompt section. A cwd change rebuilds its
execution environment and workspace context at the next request. Only one workspace
root equal to cwd is currently supported. Nonempty schema constraints, collaboration
modes and other unimplemented semantic overrides fail explicitly; accepting a prompt
request does not imply those options took effect. Paginated history with an initial
Turn window is negotiated. Shared projection helpers enforce bounded Turn/Item
counts and stable native identity cursors across reopen. `excludeTurns` omits the
legacy full Turn array; an explicitly requested initial page is still returned.
Metadata-only DSH Resume performs no history request and returns a lazy head
cursor; empty history is discovered when that cursor is read. Native entries
remain the only history authority, including when Pi must project a local native
snapshot to answer a page. This does not promise bounded local projection memory.
Archived or missing Pi threads return non-retryable typed errors preserved by
Engine Host. Client recovery stops at the existing unavailable-thread owner.

One projection consumes native entries, submissions, task timestamps, LiveDoc and
UsageDoc for streaming and history. Generation task identity plus immutable assistant
position identifies an in-flight response and its committed entry; entries without
native task attribution use their entry identity. Original input spans survive reload.
Tool namespaces and image output survive projection, and unsupported tool media fail
instead of returning a success placeholder. Bash progress uses the retained native
window; replacement/trim emits a full item update rather than a false appended delta.

A live platform-tool owner cannot be replaced during execution. Disconnect revokes
its lease and rejects pending calls; a successor may attach the same tool definitions
after the old owner expires. Replies are checked against the captured lease, so a
late reply cannot mutate the successor. Reattachment never replays an unsafe call.
Storage/watch failure explicitly settles the visible turn as failed while retaining
the native ledger and recovery hint for inspection on reopen.

Project catalogs, filesystem browsing and upload staging are Host resources. The
multi-engine endpoint serves the same deployment directories with or without DSH;
enabling Pi does not create a separate project database. Provider catalogs filter
project/cwd/provider/source first, then Host applies a common stable sort and pagination.
Corrupt individual Pi indexes remain on disk and do not prevent loading other sessions.

The Workbench may resend Full access together with its resolved native sandbox
policy. Pi accepts that redundant equivalent representation, while validating every
supplied permission field and rejecting any restricted or custom value.

Online first submissions with ready attachments or context wait for the existing Thread hydration owner before entering Conversation admission. The command retains the original references and checks lease lifetime after hydration. The text-only offline outbox does not take custody of transient asset handles; offline refusal and uncertain-execution fencing remain unchanged.

Native user-role model context is not itself user admission. Only input submissions, native UserEntry and the adapter input entry start Turns. CompactionEntry renders a stable contextCompaction item on the prior Turn without changing its execution duration; passive context writes cannot invent a user Turn.

### Pi temporary Side Chat

Pi declares `ephemeralFork` independently of persistent `fork`. The shared Side Chat
service resolves that capability for the parent Thread, forks with `ephemeral: true`
and `excludeTurns: true`, injects its boundary, then adopts the active child. The
Engine Host admits that returned child identity without a disk Resume. Persistent
Pi Fork and historical fork points remain unsupported.

A temporary owner uses native MemoryStorage. Its passive reference entry contains
the parent's committed native model context, including images, tool results and
compaction effects, rather than rendered transcript text. It inherits the current
model, thinking level, cwd, instructions and tool declarations; it never copies
active tasks, inbox inputs or usage. Parent and child execution remain independent.
Only new child input starts generation. User-text boundary injection is passive and
rejects unsupported roles/media and active-child injection before committing.

Temporary Threads have no index, SQLite database, writer lock or catalog row.
Platform-tool changes update the native registry without replacing the memory
owner. Disconnect revokes its tool lease; reconnect may reattach the same live
owner. Explicit unsubscribe disposes it and removes its identity. Server restart
loses these conversations. The normal persistent Pi owner and recovery path remain
disk-backed. Full access validation applies equally to both kinds.

### Trusted native transport composition

Headless composition may supply `decorateCodexNativeTransport`, applied only to
the independent Core native transport when Headless owns Host overlays. This
in-process boundary runs after Host execution/input admission and retains the
original account control client. It must preserve native request correlation,
notifications, connection ownership and caller tool/permission semantics. It is
not configured through renderer RPCs and never owns the Core process. Product
provider catalogs and protocol adaptation belong to product composition, not the
shared Codex adapter or global native configuration.

### Application schedule catalog

The Scheduled tasks workbench entry projects the same admitted Host summaries
used by conversation markers. It lists current active/paused plans and unresolved
acceptance, independently of conversation pagination and personal list filters.
Each task card retains its Host identity, even if conversation metadata has not loaded.
The catalog uses a responsive card grid with a task title, explicit task status,
next execution time where applicable, and conversation/management actions.
Paused tasks explain that automatic execution is suspended; Host connectivity
remains a separate group-level state when loading, offline or failed. Healthy
connections do not repeat a connected label. Each server heading exposes an
icon-only refresh action at its trailing edge, sharing the catalog-wide refresh
owner (discovery plus admitted Hosts); the page header retains only creation.
When no Hosts are available, the empty catalog retains an icon refresh for retry.
Cards consume the existing content-free
summary without per-task schedule reads or an additional execution owner.
It can navigate through the application Router or open the existing conversation
schedule editor. The catalog also creates schedules using an admitted Host’s
thread/start and schedule/save operations; no first Turn is submitted at creation.
Confirmed thread receipts are retained across name/save failures; ambiguous
thread creation is never automatically replayed. Host scope is fenced before
every request. Hosts advertising calendar support accept local daily/weekly/
monthly rules, multiple times and optional effective windows. The Host computes
future UTC occurrences using the saved IANA zone; nonexistent wall times and
month days are skipped and ambiguous wall times run once. Fixed intervals retain
their original phase and may filter weekdays. Skills are passed as explicit
instructions to the native agent. Existing conversation editing preserves these
advanced fields. Summary reads contain
no prompts or execution history and never acquire conversation execution ownership.
Unsupported, offline, loading, failed and genuinely empty Host catalogs are distinct;
same-scope cached plans survive transient disconnects. An idle connection recipe
without a negotiated schedule-summary capability or a same-scope successful
summary is not rendered as a disconnected scheduling Server. Previously confirmed
catalogs remain visible during disconnection; discovery does not connect idle
Hosts merely to populate this page. Editor requests fence the
captured Host/profile/authorization scope, with backend revision checks unchanged.

The scheduled task catalog resolves names for durable conversations missing from `thread/list` through metadata-only `thread/read`, under the same Host admission and authorization fences. This does not start a Turn or create a second title authority; failed metadata reads retain the plan with its conversation ID. Reads are limited to four concurrent requests per Host.

## Host-owned session capabilities

The [session capability service](session-capabilities.md) owns the shared catalog and invocation entry point; domain providers retain authorization and durable effect receipts. Remote MCP and native Pi/DSH adapters consume that same service. Host contributions are independent of browser capability leases, cannot be shadowed by browser declarations, and survive View disconnect. Codex installs a scoped MCP entry at creation or its next idle preparation boundary; neither global MCP configuration nor the native process becomes a per-session credential authority. IM explicit replies use captured per-arrival references and never race an automatic final send; existing final-mode records preserve their previous completion path.

### Bounded history replies

Codex, the DSH endpoint and the multi-engine Host serialize history results with
an 8 MiB UTF-8 reply budget. Oversized legacy reads or individual pages return
`HISTORY_RESPONSE_TOO_LARGE` with `retryable=false`, retaining RPC and logical
client identity, without truncating data or closing peer subscriptions. A single
item may still exceed the budget and must fail explicitly. Execution mutations
and streamed notifications are not subject to this history reply transformer.
The Session reader recognizes both this typed rejection and the native decoded
message size rejection. It retries a merged Resume without initial history, then
uses smaller read pages, halving the item limit down to one and retaining the
accepted limit across pages. A full Turn page may fall back to summaries before
item hydration. These are new bounded reads, not permission to retry the same
oversized response or replay an execution mutation. The DSH forwarding boundary
preserves JSON-RPC code and data, including unavailable-thread and retryability
classification, instead of flattening failures to their message.
Native Codex read sockets retain their independent bounded read fault domain.
The boundaries isolate requests; they do not separate tenant data or Core CPU.

Pi declares verified permission-mode presentation for its one Full access profile,
so Composer and schedule editors share the same supported catalog. Its managed
schedule database opening outcome is exposed through the provider to Host health.

A native completion may resolve a failed or late inspection, but cannot substitute
for a successful durable write. Failed occurrence writes retain the observation
and use the normal 30-second failure backoff; slot release cannot spin an immediate
retry loop. Recovery persists the same occurrence without resending its input.

## Independent server Pi execution owner

Managed deployments may set `OPENCRAFT_ENGINE_HOST_DESCRIPTOR` to attach the
Headless gateway to a pinned, independent execution Host. That Host owns Pi
native sessions, schedules, SQLite writers and native tool processes; it routes
DSH operations to the already independent DSH Host. Gateway attachment shutdown
only closes transport leases. It never closes either execution owner or replays
accepted inputs. The default in-process Headless composition remains available
for standalone deployments and does not promise gateway-restart continuity.

The owner and in-process Pi composition share an exclusive `pi-owner` lock in
the deployment data root. Migration from an older gateway requires a drained Pi
writer handoff because old versions do not acquire that lock. Configuration
validates the same machine identity, data directory, engine namespace and default
engine; an unavailable or incompatible descriptor cannot trigger a local fallback.
Native history remains the recovery authority. Browser-owned platform-tool
leases still expire on disconnect and cannot authorize replay of unknown effects.

See [server updates](web-deployment.md#独立-pi-执行-host) for configuration and the
one-time migration. Updating the execution Host itself is separate from ordinary
website/gateway/entry updates.


## Immutable execution identity

Trusted ingress carries `executionPrincipal` separately from the displayed message sender.
The provider subject is the identity key; login labels are audit data. Host SQLite v15
preserves the original submission before queue admission, and records a Turn execution
lease before sending a native start. Queue edits, dequeue operators and steer messages
do not replace that identity. A steer records its own author without changing the Turn.
Finished executions cannot lend their identity to later Turns; internal schedules, goals
and anonymous starts have no employee authority. Historical queue records without a
principal remain unknown instead of borrowing one from chat history.

`ExecutionLeaseReader` borrows a read-only Host connection. Exact execution ID plus
optional generation can query a lease; thread ID alone is insufficient. The job-origin
port additionally requires a trusted native incarnation and tool-root process birth time
with an uncertainty interval. The complete interval must fit exactly one execution;
boundaries, overlaps and unknown delivery return unknown. Closed executions return
expired. Only a known active execution without a human principal returns unowned.
The caller owns native-process attestation and readiness/reconciliation after a lost
connection. These APIs do not provide isolation against hostile processes sharing a UID.

Queue ingress into an independent engine remains pending until its native receipt
confirms a queue creation at or after the trusted capture. An older duplicate
receipt cannot backfill a historical principal from its present operator. Replayed
accepted input IDs reuse the original execution interval.

A persisted active row is a last observation. `LiveExecutionLeaseReader` additionally
requires a bounded native Turn read before personal credential admission, then
rechecks the original execution after the asynchronous read. Missed completion
returns expired; read failures return unknown. The native probes use only a
latest-Turn history read, never resume or subscribe, and ignore unsolicited native
interaction requests without responding to them.


### Independent Host execution observations

Authenticated ingress forwards its frozen submission context through
`AgentDriverTransport` only after execution authorization. The inner
`ExecutionOwnershipTransport` records the same input identity before native
admission. A queue start consumes its original persisted submitter; a steer
records an author and never acquires the running execution.

The gateway uses its existing thread-identity SQLite owner for independent
engines. On restart, unresolved leases become unknown until bounded read-only
reconciliation proves the exact original input and Turn. Inspection does not
Resume, attach callbacks, subscribe to tools or answer unsolicited interactions.
An explicit internal Host input records unowned execution; the viewer and the
last human sender are never credential fallbacks.

Independent Host descriptors expose authenticated, origin-free
`GET /execution-origin?threadId=...`. The engine owner resolves the physical
native generation and returns its PID. ACP also returns the admitted public
Turn ID, status and original input ID from its live runtime; its native history
Turn numbering is a different identity and cannot validate a public lease.
`readEngineExecutionIdentity` revalidates the descriptor and live Host before
reading this port. `observeNativeExecutionProcess` adds the process start ticks
and boot fence. The broker must verify peer ancestry and birth time against the
same native root and immutable lease, including after asynchronous inspection.
An unavailable observer is unknown, never unowned.

`createHostExecutionTurnInspector` uses the ACP owner observation, and falls
back to the bounded raw WebSocket Turn reader only for providers without an
owner Turn observation. It never follows a successor Turn or accepts a changed
original input.

### Thread identity in native shells

Pi supplies the explicit public session ID to each session's native execution
environment. Environments may be reused for the same session and working
directory because they contain only this diagnostic Thread ID; employee
credentials are resolved for each actual tool process through the broker.

DSH shell and terminal boundaries consume one read-only native-to-public
resolver. Legacy DSH uses its existing generation/checkpoint owner. DSH ACP
reads the existing atomic routing records in one fixed generation directory;
it does not construct a public ID from a native ID or create another writable
mapping. Packaging patches the pinned `dsh-bash-local` and `dsh-terminal-bash`
process environment boundaries, verifies both before writing, and rejects
upstream drift. A new ACP generation must explicitly mount the packaged
`dsh-acp-execution-environment.mjs` plugin with its `routesDirectory`; existing
pinned generations are not silently changed.

`OPENCRAFT_THREAD_ID` is diagnostic, like native Codex's `CODEX_THREAD_ID`.
Neither is credential authority. A persistent shell or background child keeps
its original process birth; after that Turn ends it cannot acquire a later
employee's lease. A fresh shell process in a later Turn is a separate origin.


### Boot clock and queue admission fences

Linux job origin queries include `bootId` and `startedAtBootMs` from the attested
process start ticks. Readers advertise `originClock: "boot-monotonic-v1"` so a
broker can refuse an older reader that would silently ignore these fields.
Host migration v16 and thread-identity migration v3 append boot-relative lease
boundaries without rewriting v15/v2. The complete uncertainty interval, including
`/proc/uptime` quantization, must fit one interval in the same boot and native
incarnation. Old rows without boot evidence remain unknown. Realtime clock jumps
cannot move an old background job to the next employee.

Queue receipts use an immutable admission nonce, not creation time, to confirm
that this principal's input was accepted. The gateway persists and overwrites
the wire nonce before native admission. Pi stores the first nonce in its native
queue; edits and duplicates preserve it. DSH echoes it only after the new native
queue admission path. Older Hosts or historical receipts without matching
admission evidence stay unknown until proven, and never inherit the current user.

### 原生交互来源失效

订阅者权限和原生请求路由可用性分别校验。共享快照的全局 `canRespond` 表示当前订阅
具备答复入口；单条请求的可选 `canRespond=false` 表示来源连接或 generation 已失效。
Codex native 连接失败/关闭、单代 lost 和 DSH runtime unavailable 会同步撤销该请求的
答复权并广播，保留原 pending/responding 状态而不伪造终结。通道重新 open 不恢复旧
请求；只有原生重新投递当前请求并建立有效路由才恢复其答复权。答复裁决前及同步
观察者发布后再次检查来源可用性，旧请求不能因页面仍在线而写入新引擎连接。

指纹计算和外部校验返回后也必须在准入helper中复核来源：若期间已撤权，返回
`SOURCE_UNAVAILABLE`，不创建answer、不额外发布responding、不调用writer。来源本身
撤权的广播仍保留，原pending槽未消费，producer可重新投递恢复可用性。已有peer
准入不因外层撤权被覆盖；该peer自己的writer失败仍按原attempt归属结算。发布后的
来源失效守卫继续保留，不把拒绝准入扩展为对已观察或未知远端写入的猜测性回滚。
