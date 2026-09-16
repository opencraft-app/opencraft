# Go 客户端与 SEA IM Bridge 设计

状态：历史设计，已由 `20-Vela正式AgentHost收敛.md` 取代
目标版本：Platform v1
适用范围：Linux、Windows，以及当前用户模式的 macOS managed Canary；均可访问公网

> 本文保留当时的设计依据，不再是发布事实源。正式 Host 是
> `raft-computer-go --mode vela`；`cmd/chatserver-agent` 已删除；Windows
> Agent Host 暂不支持。Bridge JSON Lines 与安全边界仍可作为兼容背景阅读。

## 1. 结论

v1 采用三个职责清晰的程序：

```text
chatserverctl          人类管理员使用的 Go Cobra 客户端
chatserver-agent       Agent 运行宿主与子进程监督器
chatserver-im-bridge   内嵌 Node.js 与腾讯 IM SDK 的 SEA 子进程
```

核心调用关系：

```text
管理员
  │
  ▼
chatserverctl ──HTTPS──> 平台后台 ──腾讯云 API──> TAT

Agent 本地 Runtime Credential
  │
  ▼
chatserver-agent ──HTTPS──> 平台后台
  │                         │
  │                         └─签发短期 Agent UserSig
  │
  └─JSON Lines──> chatserver-im-bridge ──WSS──> 腾讯云 IM
```

固定安全边界：

- `chatserverctl` 不持有腾讯云 CAM 密钥。
- `chatserver-agent` 不持有腾讯云 CAM 密钥或 IM 管理员密钥。
- 平台后台是唯一持有云端管理凭据的一方。
- Agent 只持有平台签发的 Runtime Credential，以及运行期内存中的短期 UserSig。
- TAT 永远由平台后台调用，客户端不直接调用腾讯云 TAT API。
- Agent 以普通 IM 用户身份直连腾讯云 IM，不使用 Robot 身份。
- 普通聊天消息由腾讯云 IM 负责存储、漫游、离线补偿和多端同步；平台不建立第二套聊天消息库。

## 2. 目标与非目标

### 2.1 v1 目标

- 通过平台 API 完成 Computer 查询和 Agent 部署、启动、停止、重启。
- Agent 使用 Runtime Credential 换取短期平台访问令牌和专属 UserSig。
- Agent 直接登录腾讯云 IM，接收 C2C、群聊/话题中明确提及自己的消息，以及平台定义的 CustomElem。
- Agent 可以通过腾讯云 IM 发送文本和 CustomElem。
- 在目标机器没有 Node.js、npm 和 `node_modules` 的情况下运行。
- 支持 Bridge 崩溃拉起、UserSig 续期、网络重连和进程退出诊断。
- 为以后替换成纯 Go IM Transport 保留稳定接口。

### 2.2 v1 非目标

- 不在平台后台代理普通聊天收发。
- 不在平台数据库保存普通消息正文、会话历史或全会话同步游标。
- 不实现 Activity 流、实时推理过程或工具调用流。
- 不向客户端开放任意 TAT 命令执行接口。
- 不复制腾讯 IM 私有 WebSocket 协议，也不在 v1 实现纯 Go 私有协议客户端。
- 不复制 OpenClaw 或 TIMBot-WS 的多账号配置、路由和插件框架。
- 不在本阶段实现 Codex、Claude、Kimi、Pi 的完整 Runtime；先完成 IM 与 TAT 的可验证闭环。

## 3. 程序职责

### 3.1 `chatserverctl`

`chatserverctl` 是人类管理员使用的 Cobra CLI，只调用平台 HTTP API。

建议的最小命令：

```text
chatserverctl login
chatserverctl logout
chatserverctl server list
chatserverctl computer list
chatserverctl computer get
chatserverctl computer refresh
chatserverctl agent deploy
chatserverctl agent start
chatserverctl agent stop
chatserverctl agent restart
chatserverctl operation get
chatserverctl operation wait
```

约束：

- 使用平台用户令牌，不接受 CAM SecretId、SecretKey 或 IM 管理员密钥。
- 不提供 `tat exec`、`run-command` 等任意命令入口。
- JSON 输出中不得出现 UserSig、Runtime Credential 或平台刷新令牌。
- 长操作通过 `operation_id` 查询，不保持客户端到 TAT 的长连接。

### 3.2 `chatserver-agent`

`chatserver-agent` 是机器上的 Agent 运行宿主，负责：

- 从权限为 `0600` 的文件读取 Runtime Credential。
- 调用 `POST /v1/runtime/session` 换取短期会话。
- 启动、监控和停止 `chatserver-im-bridge`。
- 将短期 UserSig 通过标准输入管道发送给 Bridge。
- 根据 Runtime Session 中的 Agent UserID 和回复策略配置本地路由。
- 对 Bridge 事件做 launch fencing，忽略旧子进程迟到输出。
- 在 UserSig 到期前主动刷新 Runtime Session。
- 对崩溃做有限次数指数退避重启；持续失败时退出，由 TAT/系统服务恢复。

最小命令：

```text
chatserver-agent run --credential-file <path>
chatserver-agent doctor --credential-file <path>
chatserver-agent canary --credential-file <path>
chatserver-agent version
```

`canary` 只验证登录、收发、重连和凭据安全，不执行真实 LLM。完整 Agent Runtime 后续通过内部 `RuntimeAdapter` 接口接入。

### 3.3 `chatserver-im-bridge`

Bridge 是内部实现细节，不面向终端用户：

- 使用固定版本 Node.js LTS 构建 SEA 可执行文件。
- 内嵌打包后的腾讯 `@tencentcloud/lite-chat` Node 版本、`ws` 和原创 Bridge 代码。
- 通过标准输入/标准输出交换 JSON Lines。
- 标准输出仅允许协议帧；脱敏日志写标准错误。
- 每个 Agent 对应一个 Bridge 进程，避免 SDK 单例和身份状态相互污染。
- 不在磁盘解包 JavaScript、UserSig 或 SDK 状态。
- 不解释 Task、Reminder 等业务语义，只负责 IM 登录、收发与连接状态。

## 4. 平台 Runtime Session

Agent 使用：

```http
Authorization: AgentCredential <runtime-credential>
POST /v1/runtime/session
```

平台返回的最小信息：

```json
{
  "accessToken": "<short-lived-platform-token>",
  "expiresAt": "2026-07-30T12:00:00Z",
  "agent": {
    "id": "01900000-0000-7000-8000-000000000001",
    "serverId": "01900000-0000-7000-8000-000000000002",
    "userId": "a_example",
    "replyPolicy": "mention_and_dm",
    "runtime": {
      "kind": "codex",
      "model": "default"
    }
  },
  "im": {
    "sdkAppId": 1000000000,
    "userId": "a_example",
    "userSig": "<short-lived-usersig>",
    "expiresAt": "2026-07-30T12:00:00Z"
  }
}
```

规则：

- SDKAppID 不是秘密，可传给 Agent。
- UserSig 仅属于当前 Agent UserID，且必须短期有效。
- UserSig 不写磁盘、不进入命令行参数、环境变量、日志或错误详情。
- Runtime Credential 可以轮换；平台校验 credential version，旧凭据不能继续建立新会话。
- Agent 在 IM UserSig 到期前刷新整个 Runtime Session，不单独请求永久 UserSig。
- 客户端直接复用 OpenAPI `RuntimeSession`，不维护另一套专用字段命名。

## 5. Go 内部接口

Go 代码不依赖具体 SEA 实现：

```go
type IMTransport interface {
    Start(ctx context.Context, session IMSession) error
    SendText(ctx context.Context, req SendTextRequest) (SendReceipt, error)
    SendCustom(ctx context.Context, req SendCustomRequest) (SendReceipt, error)
    Events() <-chan IMEvent
    Close(ctx context.Context) error
}
```

首个实现为 `SEAIMTransport`。以后如确有必要，可以增加 `NativeGoIMTransport`。

业务层只使用 `IMTransport`，不得依赖 Node SDK 对象、TIMBot-WS 类型或腾讯私有 Wire 字段。

Runtime 也通过接口隔离：

```go
type RuntimeAdapter interface {
    HandleMessage(ctx context.Context, message IncomingMessage) error
    HandleCustom(ctx context.Context, event IncomingCustomEvent) error
    Close(ctx context.Context) error
}
```

v1 首先实现仅供 Canary 使用的探针 Adapter，真实模型 Runtime 后续独立接入。

## 6. Bridge JSON Lines 协议

### 6.1 通用信封

请求：

```json
{"v":1,"id":"req_01","type":"login","payload":{}}
```

响应：

```json
{"v":1,"id":"req_01","type":"result","ok":true,"payload":{}}
```

事件：

```json
{"v":1,"event_id":"evt_01","launch_id":"launch_01","type":"message","payload":{}}
```

错误：

```json
{
  "v": 1,
  "id": "req_01",
  "type": "result",
  "ok": false,
  "error": {
    "code": "invalid_request",
    "message": "请求格式无效",
    "retryable": false
  }
}
```

兼容规则：

- `v` 必须为支持的主版本。
- 未知字段忽略并保留向前兼容。
- 未知命令返回 `unsupported_command`，不得导致进程崩溃。
- 每个请求恰好产生一个对应 `result`。
- 异步事件使用独立 `event_id`；Go 依据 `launch_id` 丢弃旧进程事件。
- 单行默认上限 8 MiB，超限立即拒绝并终止该 Bridge。
- 消息正文和 CustomElem 内容不得被默认日志记录。

### 6.2 v1 命令

```text
initialize
login
logout
send_text
send_custom
ping
shutdown
```

`initialize` 传入非秘密配置与 `launch_id`。
`login` 传入 SDKAppID、Agent UserID 和短期 UserSig。
`send_text` 和 `send_custom` 传入腾讯会话定位与内容。
`shutdown` 请求优雅退出。

### 6.3 v1 事件

```text
ready
login_succeeded
login_failed
message
network_changed
usersig_expiring
kicked_out
sdk_error
stopped
```

`message` 统一投影为：

```json
{
  "message_ref": {
    "conversation_type": "c2c|group|topic",
    "conversation_id": "string",
    "message_id": "string",
    "sequence": 1,
    "timestamp_ms": 1785398400000
  },
  "sender": {
    "im_user_id": "string"
  },
  "elements": [
    {
      "type": "text|custom|mention|attachment|unknown",
      "text": "可选",
      "custom_type": "可选",
      "data": "可选"
    }
  ]
}
```

平台业务对象只保存稳定的 `message_ref`。Bridge 和 Agent 不把普通消息正文回传到平台。

## 7. 消息路由与正确性

腾讯云 IM 负责：

- 普通消息持久化。
- 群聊与 C2C 投递。
- 离线补偿与漫游。
- 消息顺序、重复投递语义和 SDK 确认。
- 多端同步和会话状态。

平台负责：

- Human、Agent 与腾讯 IM UserID 的稳定映射。
- Server、Member、Agent、Computer 等业务对象。
- Agent 的可用性、生命周期和权限。
- Task、Reminder 等业务终态。
- 业务对象到腾讯消息的稳定引用。

Agent 收到普通消息后：

1. 依据 Runtime Session 的 `replyPolicy` 判断是否应该响应。
2. `mention_and_dm` 处理 C2C，以及群聊/话题中明确提及自己的消息。
3. `dm_only` 只处理 C2C；`all_channel_messages` 处理已加入群聊/话题的全部消息。
4. 平台 CustomElem 只作为唤醒和定位信息；Task、Reminder 的真值必须通过平台 HTTP API 读取。
5. 普通文本回复直接通过腾讯 IM 发送。

平台不会因短暂故障而替腾讯 IM 建立第二条聊天消息写入路径。

## 8. TAT 调用与安装

标准链路：

```text
chatserverctl
  → 平台 Agent/Computer 生命周期 API
  → 平台校验 Server 与角色权限
  → 平台创建 operation
  → 平台 TAT Adapter 执行固定模板
  → operation 更新为成功或失败
```

v1 固定模板：

```text
deploy-agent
start-agent
stop-agent
restart-agent
inspect-agent
```

安装包包含目标平台对应的两个运行文件：

```text
chatserver-agent
chatserver-im-bridge
```

安装要求：

- 发布物固定版本、SHA-256 和签名。
- TAT 脚本下载到临时版本目录，校验后原子切换当前版本。
- 不覆盖仍在运行的文件。
- Runtime Credential 由平台通过一次性注册流程写入权限为 `0600` 的文件。
- 不使用命令行参数或环境变量传递 Runtime Credential。
- 机器上不要求安装 Node.js、npm 或 `node_modules`。
- 回滚只切换已验证的上一版本目录，不回滚 Runtime Credential。

## 9. 生命周期与故障处理

### 9.1 Bridge 监督

- Go 以绝对路径启动 Bridge，不通过 `PATH` 搜索。
- 启动后必须在限定时间内收到 `ready`。
- Bridge 崩溃采用带抖动的指数退避，最大 30 秒。
- 连续失败达到阈值后，`chatserver-agent` 退出非零状态。
- 标准输出出现非协议文本、畸形 JSON 或超大帧时，视为 Bridge 故障。
- 退出时先发送 `shutdown`，超时后强制结束子进程。

### 9.2 会话续期

- 根据平台返回的 `expiresAt` 提前续期，并加入随机抖动。
- 新 Session 成功后，以新的 `launch_id` 重启或重新登录 Bridge。
- 旧 `launch_id` 的所有迟到事件丢弃。
- 平台返回 Credential revoked、credential version stale 或 Agent 已停用时立即停止，不无限重试。

### 9.3 消息重复

- 普通聊天重复由腾讯 IM SDK 与 Runtime 的幂等处理共同约束。
- 对 Task、Reminder 等有副作用的操作，必须使用平台业务 ID 和幂等键。
- 不以“收到 IM 消息”代表业务任务已完成。
- 进程重启后通过平台 Task/Reminder 状态做业务对账，不依赖本地聊天游标恢复业务终态。

## 10. 安全要求

- 客户端源码、发布物、测试夹具和日志均不得包含真实云端密钥。
- UserSig、Runtime Credential、平台访问令牌统一按敏感值脱敏。
- Runtime Credential 文件权限必须校验；权限过宽时拒绝启动。
- Bridge 标准输出只承载协议，标准错误日志必须脱敏。
- 禁止把敏感值放入进程标题、命令行参数、崩溃报告或诊断包。
- Bridge 子进程只继承最小环境变量；清除无关代理和凭据变量。
- 本地协议不监听 TCP 端口，不创建可被其他用户访问的 Unix Socket。
- Go 主进程限制 Bridge 的启动频率、最大帧和待处理请求数。
- 发布时固定 Node、腾讯 IM SDK、`ws` 和打包器版本，并记录许可证与校验哈希。

## 11. 参考实现与 clean-room 边界

`Tencent-RTC/TIMBot-WS` 只作为以下内容的参考：

- Node SDK 初始化和登录方式。
- Worker/主线程之间的消息封装。
- IM 收件事件到统一消息模型的映射。
- 断线、登录失效和 SDK 错误的处理路径。

不采用：

- OpenClaw 插件接口。
- 多账号配置系统。
- Binding、路由和频道抽象。
- 仓库中的构建目录或未发布依赖。
- 原实现的私有控制流和内部命名。

实际运行依赖使用腾讯发布的 `@tencentcloud/lite-chat` Node SDK。Bridge 协议、Go 监督器和领域投影均为本项目原创实现。

## 12. 测试策略

### 12.1 Go 测试

- 使用假的 Bridge 子进程覆盖所有 JSON Lines 命令和事件。
- 覆盖启动超时、异常退出、畸形 JSON、超大行、请求超时和优雅关闭。
- 覆盖旧 `launch_id` 事件丢弃、UserSig 续期、Credential revoked 和 credential version stale。
- 覆盖日志脱敏、文件权限和敏感值不进入参数/环境。
- 使用假的平台 HTTP Server 测试 Runtime Session 和 TAT operation，不在单元测试调用真实腾讯云。

### 12.2 Bridge 测试

- 将腾讯 SDK 包装在最小 Adapter 后测试，不让协议层直接依赖 SDK 全局对象。
- 覆盖登录成功、登录失败、踢下线、网络变化、文本、CustomElem、群聊提及和未知 Elem。
- 检查标准输出只有合法 JSON Lines。
- 检查 UserSig 不出现在日志、错误和快照中。

### 12.3 Canary

真实环境验收至少包括：

1. 平台为测试 Agent 签发短期 UserSig。
2. Agent 以普通 IM UserID 登录。
3. 收到一条 C2C 文本并回复。
4. 收到群聊或话题中的明确提及并回复。
5. 收到平台 CustomElem，并通过 HTTP 获取对应业务真值。
6. 断网恢复后继续收取腾讯 IM 离线消息。
7. UserSig 续期成功，旧 Bridge 事件不污染新会话。
8. 管理员通过 `chatserverctl` 发起 deploy/start/status/stop，实际 TAT 只由后台调用。
9. 客户端、日志和平台数据库均不出现普通消息副本或云端管理密钥。

## 13. 分阶段实施

### 阶段 A：本地协议和监督器

- 定义 Go `IMTransport`、Bridge 信封和错误码。
- 先写假的 Bridge 与 Go 测试。
- 实现进程启动、请求关联、事件流、退出和脱敏。

### 阶段 B：SEA Bridge

- 写腾讯 SDK Adapter。
- 实现登录、文本、CustomElem 和接收事件。
- 生成固定版本 SEA，并完成无 Node.js 机器的运行测试。

### 阶段 C：平台会话和 Cobra CLI

- 完成 `chatserver-agent run/doctor/canary`。
- 完成 `chatserverctl` 的最小 Computer、Agent 和 operation 命令。
- 与现有 OpenAPI 契约保持一致。

### 阶段 D：TAT 与 IM Canary

- 后台接入真实 TAT Adapter 和 IM UserSig Provider。
- 用独立测试 Server、Computer、Human 和 Agent 完成闭环。
- 通过凭据扫描、故障注入和审计后再接真实 Runtime。

## 14. 验收门槛

- 目标机器只有两个发布文件也能运行，不需要系统 Node.js。
- Agent 直连腾讯云 IM，后台不代理普通消息。
- Agent 与 CLI 均不持有腾讯云管理凭据。
- UserSig 只存在于短期 Runtime Session 和 Go→Bridge 内存管道。
- TAT 只能通过平台固定生命周期操作触发。
- Bridge 故障、续期、重连和旧事件都有确定行为。
- 单元测试不依赖真实腾讯账号；Canary 使用隔离测试身份。
- 未来切换纯 Go Transport 不需要修改业务层。
