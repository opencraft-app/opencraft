# TAT + 腾讯云 IM 版 Agent 改造评估

日期：2026-07-30

## 1. 结论

原 `raft-computer-go` **适合成为新版 Agent Runtime 的代码来源，但不适合在现有
Runner 外壳上直接改**。

建议：

1. 保留 `runtimeapi`、`runtimecatalog`、`agentmanager`、Codex、Hermes、
   gated steering 等 Runtime 内核；
2. 新建单 Agent、单系统服务的 `AgentHost`；
3. 用腾讯云 IM 官方 C SDK 的 Linux/Windows 版本接管消息长连接；
4. 用平台 `/runtime/session` 换取短期 Runtime Token 和 UserSig；
5. 保留回环 Capability Gateway，使模型调用的 `raft` CLI 不接触 UserSig；
6. 删除 Computer CLI、machine service、per-Server runner、旧控制 WebSocket、
   Agent Delivery/ACK、Activity 上传、workspace migration 等旧平台外壳。

因此它不是小范围改 URL，但也不是重新实现 Agent。更准确的描述是：

> 重写约三分之二的外围代码，保留最难、最有价值的 Runtime 行为内核。

从功能复杂度看，Codex/Hermes 的进程协议、session resume、busy steer、launch
fencing、stale output 抑制和事件归一化都可以复用；这些比新 Host 的工程代码更难。

## 2. 当前代码实际做了什么

当前单个可执行文件承担四种角色：

```text
raft-computer-go CLI
  └── __service
       └── 每 Server 一个 __run
            ├── /daemon/connect WebSocket
            ├── 最多五个 Agent
            ├── Codex/Hermes Runtime
            ├── 本地 Capability Gateway
            └── __agent-cli
```

入口证据：

- `cmd/raft-computer-go/main.go:30` 选择四种角色；
- `cmd/raft-computer-go/main.go:65` 启动 machine service；
- `cmd/raft-computer-go/main.go:129` 启动 per-Server runner；
- `cmd/raft-computer-go/main.go:159` 启动 Agent-facing CLI。

`runner.Run` 同时装配旧控制协议和 Runtime：

- `internal/runner/run.go:74`：workspace migration；
- `internal/runner/run.go:117`：原本地 Reminder scheduler；
- `internal/runner/run.go:123`：旧 delivery inbox；
- `internal/runner/run.go:132`：Runtime catalog；
- `internal/runner/run.go:143`：Agent Manager；
- `internal/runner/run.go:157`：本地 Gateway；
- `internal/runner/run.go:184`：旧 `/daemon/connect` transport；
- `internal/runner/run.go:244`：Runtime Event → 旧云端 Activity。

这说明 `runner` 是聚合层，不是应该整体保留的 Runtime 内核。

## 3. 新版目标拓扑

每个平台 Agent 对应一个 TAT 管理的系统服务：

```text
腾讯云 TAT
  └── deploy/start/stop/restart/probe
       └── AgentHost（一个 Agent）
            ├── Runtime Session Client
            │    └── /runtime/session → Token + UserSig
            ├── IM Bridge
            │    └── 腾讯云 IM 官方 C SDK
            ├── Message Router
            │    ├── replyPolicy
            │    ├── 本地消息处理引用日志
            │    └── Task/Reminder CustomElem 对账
            ├── Runtime Manager
            │    └── Codex / Hermes
            └── Loopback Capability Gateway
                 └── raft CLI
```

TAT 只负责系统服务生命周期，不承载 Agent 的日常消息流。AgentHost 启动后常驻，
自行登录 IM。IM 消息到达时，Host 再决定启动、恢复或 steer Runtime Session。

Computer 不再运行平台自研长连接，也不再管理多个 Server runner。

## 4. 保留、改造与删除矩阵

| 当前包/能力 | 决策 | 新版用途 |
|---|---|---|
| `runtimeapi` | 保留 | Driver/Session 统一接口 |
| `runtimecatalog`、`runtimes` | 保留 | Runtime 注册、探测和配置 |
| `codex` | 基本保留 | Codex app-server 协议、resume、steer、事件归一化 |
| `hermes`、`hermesgateway` | 保留并平台化 | Hermes Runtime；补 Windows 文件/进程抽象 |
| `gatedsteering` | 保留 | busy 时的安全 steer |
| `agentmanager` | 精简保留 | 单 Agent 的 queue、restart、fencing、turn completion |
| `runtimeprompt` | 改造 | 输入改为腾讯 IM message context，保留“工具发送才可见” |
| `gateway` | 重写路由、保留安全模型 | 本地 IM/平台能力网关 |
| `agentcli` | 大幅收缩 | 只保留 IM 与当前 Agent 业务命令 |
| `agent` durable inbox | 改为消息引用日志 | 记录 IM message ref 和处理状态，不复制聊天正文 |
| `state` | 精简并跨平台 | 单 Agent 配置、Runtime session、消息处理状态 |
| `runner.Controller` | 拆解 | 只保留 launch planning/fencing 思想 |
| `runner.Core` | 删除 | 它是原 1.0.13 控制帧聚合层 |
| `control`、`protocol` | 删除 | 新平台没有自有 Computer WebSocket |
| `cloud` attach/login | 删除 | TAT 安装 credential，Host 只调用 `/runtime/session` |
| `service`、`ipc`、Computer CLI | 删除 | systemd/Windows Service 与 TAT 取代 |
| `migration` | 删除 | v1 不再由 Computer 做原 workspace 对象迁移 |
| 原本地 Reminder scheduler | 删除 | ReminderOccurrence 由平台数据库与 Scheduler 负责 |
| Activity/trajectory upload | 删除 | v1 没有 Activity 产品面 |

### 4.1 为什么 Agent Manager 仍值得保留

`RuntimeSession` 的边界已经很干净：

```text
Deliver
Stop
Events
SessionID
```

并额外支持 native steer、turn interrupt 和 liveness。Agent Manager 已经实现：

- Runtime 类型选择；
- session resume；
- busy delivery gate；
- pending queue；
- Runtime restart/backoff；
- terminal recovery；
- stale launch output 抑制；
- turn completion；
- 最大队列保护。

其对旧 `protocol` 的实际生产耦合只有一处 local launch ID 判断，可以轻易迁出。

新版每个进程只管理一个 Agent 后，可以删除“最多五个并发 Agent”和 per-Agent map
带来的部分复杂度，但不应丢掉上述状态机。

## 5. 消息处理模型

> 本节的长期 AgentCredential 启动流程已由 2026-08-01 C-lite Launch Fence 契约取代；
> 保留以下文字仅用于解释早期方案，不再代表正式实现。

### 5.1 启动

```text
systemd / Windows Service 启动 AgentHost
  → 读取 config.json 与 runtime.credential
  → POST /runtime/session
  → 获得 Runtime Token、UserSig、Agent/Server/Channel 配置
  → 初始化腾讯云 IM SDK
  → 以 Agent UserID 登录
  → 拉取/恢复未处理消息引用
  → 对账当前 Task 与 ReminderOccurrence
```

UserSig 过期时重新调用 `/runtime/session`，再更新 IM 登录票据。长期
AgentCredential 只由 Host 读取，不注入模型环境。

### 5.2 收消息

```text
IM SDK 收到 C2C/群消息/CustomElem
  → 标准化 MessageEnvelope
  → 校验当前 Agent、Server 和 membership
  → 应用 replyPolicy
  → 写本地 ProcessingRef
  → 转为 runtimeapi.Delivery
  → Agent Manager Start / Resume / Steer / Queue
```

`ProcessingRef` 只需保存：

```text
conversation key
message ID
receivedAt
state = accepted | running | completed | ignored
runtimeEpoch
```

不长期复制消息正文。消息正文和历史仍由腾讯 IM SDK/云端保存；发生崩溃时根据引用
从 SDK 历史恢复。

### 5.3 发消息

原 Agent 的 standing prompt 已经要求模型通过：

```text
raft message send --target <exact-target>
```

发送。新版继续保持：

```text
Codex/Hermes
  → 独立 raft CLI 进程
  → 127.0.0.1 Capability Gateway
  → Host 校验 runtimeEpoch、capability、membership
  → IM SDK send
```

模型的 `assistant_message` Runtime Event 不自动发到聊天。这避免 reasoning、恢复历史、
重复 terminal event 或错误输出意外成为公开消息。

### 5.4 Task 和 Reminder

平台发给 Agent 的 CustomElem 只作为唤醒信号：

```text
type + serverId + resourceId + revision + eventId
```

Host 收到后使用 Runtime Token 读取平台事实。启动、重新登录和定时周期也主动对账；
IM 通知丢失不会丢 Task/Reminder。

## 6. 腾讯云 IM 接入方式

腾讯云官方客户端 API 当前没有 Go SDK，但提供 C 接口，并有 Linux/Windows SDK。
C API 已提供：

- 初始化、登录、登出；
- UserSig 过期、被踢、网络状态回调；
- 新消息回调；
- 消息发送；
- 历史消息、会话列表；
- 群组、社群与话题；
- reaction、附件等消息能力。

官方文档还说明：登录态下 SDK 会自动断网重连，并在恢复后拉取消息。因此不要重新
实现旧 `control.Transport` 的 ping/watchdog/backoff 或 Delivery ACK。

官方依据：

- [腾讯云 IM C 接口总览](https://cloud.tencent.com/document/product/269/33544)
- [C API 初始化、登录和自动重连](https://im.sdk.qcloud.com/doc/zh-cn/TIMManagerFunction_8h.html)
- [腾讯云 IM 终端 SDK 更新记录](https://cloud.tencent.com/document/product/269/1606)

### 6.1 推荐：原生 IM Bridge sidecar

不建议让 C SDK 的 JSON、callback 和内存所有权扩散到 Go 业务代码。建议定义：

```go
type Client interface {
    Login(ctx context.Context, session Session) error
    RefreshUserSig(ctx context.Context, userSig string) error
    Events() <-chan Event
    Send(ctx context.Context, message OutboundMessage) (Receipt, error)
    History(ctx context.Context, query HistoryQuery) ([]Message, error)
    Close(ctx context.Context) error
}
```

生产实现使用一个很小的 C/C++ `im-bridge` 子进程：

- 链接腾讯官方 SDK；
- 通过继承的 stdio/匿名管道与 Go Host 交换版本化 JSON；
- UserSig 不进入命令行、环境变量或普通日志；
- SDK 崩溃不直接破坏 Go Runtime 状态；
- Linux/Windows 分别打包官方动态库；
- Go 测试使用纯 Go fake，不需要加载 SDK。

相比直接 CGO，这会多一个受 Host 监管的本地子进程，但能显著降低 Windows
交叉构建、callback、ABI 和原生崩溃风险。它不是新的云端通道。

## 7. 回环 Capability Gateway 的新职责

当前 Gateway 已实现：

- 仅绑定 `127.0.0.1`；
- 高熵每 launch token；
- capability 白名单；
- 上游身份头覆盖；
- 禁止重定向；
- launch generation 撤销。

这些机制应该保留，但注册对象从云端 launch 改为本地 `runtimeEpoch`：

```text
AgentID
runtimeEpoch
capabilities
platform access token（仅 Host 内存）
IM Client handle（仅 Host 内存）
```

子进程只得到：

```text
RAFT_AGENT_API_URL=http://127.0.0.1:<random>
RAFT_AGENT_TOKEN_FILE=<mode-0600 file>
```

Host 重启 Runtime 时撤销旧 epoch。旧模型进程即使继续输出，也无法发消息或修改 Task。

## 8. CLI 应如何收缩

原 CLI 有 62 条叶命令。新 v1 不应追求完整兼容。

### 8.1 保留并改到 IM

```text
auth whoami
inbox check
message send
message check
message read
message search
message resolve
message react
attachment upload
attachment view
channel info
channel members
profile show
```

其中 target 必须由 Host 生成并要求模型原样复用。可以同时展示 `#名称`，但真正发送
使用包含 C2C/group/topic/message identity 的不透明 target，Host 再校验 membership。

### 8.2 保留并改到平台 HTTP

```text
server info
task list
task update
reminder occurrence list
reminder occurrence ack
```

### 8.3 v1 删除

```text
Channel 创建/修改/成员管理/join/leave
Server/Profile 修改
Manual/Knowledge
Mention orchestration
Integration App
Action prepare
Workspace migration
Agent 自主 Task create/claim/unclaim
Agent 自主 Reminder schedule/update/snooze/cancel
```

原因不是无法实现，而是新版领域权限已经明确：Runtime Token 不管理 Channel、
Server、Computer 或其他成员，只能读写自己的消息、已分配 Task 和 due
ReminderOccurrence。

如果要求全部 62 条命令兼容，就必须把大量已经删除的后台语义重新引入，整体复杂度
会回到原 Raft 水平。

## 9. 新版 OpenAPI 在实施前需要补齐的两点

### 9.1 Runtime Channel 映射

文本规格称 `/runtime/session` 返回 Server、Channel 和 Runtime 配置，但当前
OpenAPI 的 `RuntimeSession` 只包含 Agent identity 和 IM 票据。

至少需要新增只读 Runtime 资源：

```text
GET /runtime/channels
```

返回当前 Agent 已授权的：

```text
channelId
name
visibility
imGroupId
imTopicId
membershipVersion
```

或者把同等 bootstrap 数据放入 `/runtime/session`，再提供 revision 增量刷新。
否则 Agent 能收到 native IM 消息，却无法可靠完成平台 Channel 与 IM Topic 的稳定
映射。

### 9.2 Task/Reminder 命令边界

当前 OpenAPI 允许 Runtime：

- list/get/update 当前 Agent 的 Task；
- list/ack 当前 Agent 的 ReminderOccurrence。

不允许 Runtime：

- claim/create Task；
- create/update/snooze/cancel Reminder。

这与原 CLI 不同，但与新版权限规格一致。实施前应把这个差异正式写入
Agent capability matrix，不应由 CLI 运行时猜测。

## 10. Windows 影响

当前完整程序：

- Linux amd64 生产构建通过；
- Windows amd64 生产构建失败。

Windows 阻塞包括：

- `filelock` 只有 Darwin/Linux 实现；
- migration filesystem/adopt 只有 Unix 实现；
- machine service 使用 Unix socket、`Setsid` 和 Unix signal；
- Hermes profile 使用 `x/sys/unix`；
- 现有部署脚本只有 Linux。

新版删除 migration、machine service、Unix socket 和 detached per-Server runner 后，
大部分阻塞自然消失。仍需增加：

- Windows Service 安装/停止模板；
- Windows 文件锁；
- Job Object 或等价的子进程树终止；
- Runtime liveness 的 Windows 实现；
- 腾讯 IM C SDK DLL 与 Hermes/Codex 可执行文件探测；
- Windows ACL，替代 Unix `0600/0700` 语义。

因此建议先完成 Linux Canary，再保持同一接口补 Windows，不在业务层分叉。

## 11. 推荐实施顺序

### 阶段一：冻结 Agent v1 契约

1. 补齐 `/runtime/channels`；
2. 冻结 IM MessageEnvelope、CustomElem 和 opaque reply target；
3. 冻结保留的 Agent CLI 命令；
4. 明确 Task/Reminder Runtime 权限；
5. 定义 TAT deploy/start/stop/restart/probe 输出。

### 阶段二：建立新 AgentHost

1. 新建 `cmd/chatserver-agent`，不要继续扩展原 Computer 入口；
2. 实现 config/credential 读取和 `/runtime/session` 续期；
3. 抽取 Runtime catalog、Agent Manager 和 Codex；
4. 使用本地 `runtimeEpoch` 替换云端 launchID；
5. 改造回环 Gateway 和最小 `raft` CLI。

### 阶段三：接入 IM

1. 先以纯 Go fake IM Client 完成消息状态机测试；
2. 实现 Linux `im-bridge`；
3. 实现 C2C、群 @、CustomElem、history、send、attachment；
4. 做断网、UserSig 过期、被踢、进程崩溃和重复回调测试；
5. 验证本地 message ref 恢复不复制平台聊天数据库。

### 阶段四：TAT Canary

1. 通过固定模板安装 Agent bundle 和 systemd；
2. 写入 staged credential 后切换 active version；
3. start 后验证 IM online；
4. 完成 Human → Agent → Codex → `raft message send` → Human 闭环；
5. 验证 Task/Reminder CustomElem 和 HTTP 对账；
6. 验证 TAT probe、stop、restart 和旧 Runtime epoch 失效。

### 阶段五：Windows

在 Linux 契约不变的基础上补 IM SDK DLL、Windows Service、ACL、进程树终止和
Hermes 平台抽象。

## 12. 验收标准

- Computer 不建立平台自研 WebSocket；
- TAT 能幂等 deploy/start/stop/restart/probe；
- AgentHost 只用长期 credential 换取短期 Token/UserSig；
- UserSig 永不进入模型环境、命令行和日志；
- Human 和 Agent 通过腾讯 IM SDK 直接收发；
- IM 断网恢复后不会复制执行已经完成的消息；
- C2C、群 @ 和 replyPolicy 行为正确；
- 模型只有调用 `raft message send` 才产生可见消息；
- 旧 runtimeEpoch 的 CLI token 和 Runtime 输出不能产生副作用；
- Task/Reminder 通知丢失后仍能通过 HTTP 对账恢复；
- Runtime Event 只驱动本地状态，不重新建设 Activity；
- Linux Canary 通过后再声明 Agent 改造完成。

## 13. 最终判断

Agent **好改造，但必须按“抽内核、换外壳”来做**：

- 最难的 Runtime Driver 和会话状态机已经存在且测试健康；
- TAT 删除了 Computer supervisor 和云端控制隧道；
- IM SDK 删除了自研消息重连、ACK、历史和会话正确性；
- 新增工程集中在 IM 原生桥、Host 消息路由和最小 CLI；
- Windows 不是业务架构风险，而是原生 SDK、服务和进程管理的工程工作。

若先做 Linux + Codex，风险可控；若一开始要求 Windows、Hermes 和原 62 条 CLI
全部兼容，复杂度会明显反弹。
