# Agent 自动回复与 TAT PTY 设计

状态：历史设计；Agent Host 部分已由 Platform v1 `20/21` 规格取代
日期：2026-07-30
涉及仓库：

- 后台与 Agent：`/Users/skipzhang/code/chatserver`
- Node TUI 与共享客户端：`/Users/skipzhang/new-api/raft-web`
- 可复用 Runtime 证据：`/Users/skipzhang/new-api/research/raft-computer-1.0.13/go-client`

> 本文中的 `chatserver-agent` 表示已经删除的旧实现。当前唯一正式入口为
> `raft-computer-go --mode vela`；后台的 TAT/PTY 控制面结论仍有效。

## 1. 结论

v1 采用三条彼此独立的连接：

```text
TUI / Web / Expo ──HTTPS──> Go 后台 ──腾讯云管理 API──> TAT
TUI / Web / Expo ──SDK/WSS──────────────────────────> 腾讯云 IM
Agent             ──SDK/WSS──────────────────────────> 腾讯云 IM
```

创建 PTY 时，Go 后台先签发短期会话，TUI 再连接签发结果中的临时 WSS：

```text
TUI ──HTTPS──> Go 后台 ──内部 TAT Session Issuer──> 一次性会话
TUI ──临时 WSS────────────────────────────────────> TAT PTY 数据面
```

固定边界：

- Go 后台是唯一调用腾讯云 TAT 管理面、持有云管理凭据的组件。
- TUI 不调用 TAT 管理 API，不持有 CAM Secret。
- TUI 是“无界面的 Web 客户端”：平台 HTTP、腾讯 IM SDK/WSS 和终端 WSS
  都通过可被未来 Web/Expo 复用的 TypeScript 客户端端口实现。
- Human 与 Agent 都以普通、对等的腾讯 IM UserID 登录；不使用 Robot 身份。
- 腾讯云 IM 是聊天事实源。平台不保存消息正文、不代理消息、不建立第二套聊天库。
- TAT 不进入聊天热路径；它只负责 Computer 纳管、Agent 安装与生命周期、状态检查和
  按需 PTY。

## 2. v1 范围

### 2.1 必须完成

1. `chatserver-agent` 收到符合 `replyPolicy` 的腾讯 IM 消息后启动或恢复 Runtime。
2. 首版 Runtime 支持 `codex` 与 `hermes-gateway`。
3. Runtime 通过受控的 Agent-facing `raft message reply` 能力发回腾讯 IM。
4. 重复消息、旧 launch 输出和 Runtime 重启不能造成重复副作用。
5. Go 后台实现 `POST .../terminal-sessions`，校验 Human、Server、Computer 和
   TAT 在线状态后签发一次性 PTY。
6. Node TUI 实现独立的 `terminal` 命令，使用原始终端模式桥接 TAT PTY。
7. IM、平台 API 和 Terminal 三类协议均通过共享客户端端口隔离，不与 Ink 组件绑定。

### 2.2 明确不做

- 不实现 Hermes ACP，也不做 Hermes Gateway 到 ACP 的静默回退。
- 不自动把 Runtime stdout、reasoning、tool event 或最终 assistant event 发送到群聊。
- 不在平台或 Agent 本地保存完整聊天历史。
- 不由 Go 后台代理腾讯 IM 或 PTY 字节流。
- 不在 Ink 主界面内实现完整 ANSI 终端模拟器。
- 不开放任意 TAT RunCommand；仍只允许固定生命周期模板和 PTY 会话签发。
- 不把 `sandboxId`、`poolId` 等供应商内部路由字段加入 Computer 领域模型。
- v1 不开放模型指定任意腾讯会话地址的 `raft message send`；它需要额外的平台
  `ConversationAuthorizer`，留到后续版本。

## 3. TUI 与共享客户端

TUI 只负责命令解析与呈现。可复用能力放在 `packages/client-core`：

```text
PlatformPort   登录、Server、Member、Agent、Computer、终端会话签发
MessagingPort  腾讯 IM 登录、会话、历史、搜索、收发与实时事件
TerminalPort   一次性 PTY WSS、握手、输入输出、resize、heartbeat、close
```

路由规则：

| 命令 | 调用路径 |
| --- | --- |
| `chat history/send/watch` | TUI → `MessagingPort` → 腾讯云 IM |
| Server/Member/Agent/Computer | TUI → `PlatformPort` → Go 后台 |
| Agent deploy/start/stop/restart | TUI → Go 后台 → TAT |
| `terminal` | TUI → Go 后台签发 → TUI 直连临时 TAT WSS |

`apps/cli` 可以提供 Node 需要的 WebSocket、存储和终端原始模式适配器，但协议状态机
必须位于共享客户端层。未来浏览器或 Expo 只替换运行环境适配器。

## 4. Agent 自动回复

### 4.1 输入筛选

`chatserver-agent` 使用 Runtime Session 中的 `replyPolicy`：

- `dm_only`：只处理 C2C。
- `mention_and_dm`：处理 C2C，以及群聊/话题中明确提及当前 Agent 的消息。
- `all_channel_messages`：处理 Agent 已加入群聊/话题的所有普通消息。

统一前置过滤：

- 忽略当前 Agent 自己发送的消息。
- 忽略不支持或没有可消费内容的消息。
- 使用腾讯 `messageId` 与稳定会话地址生成输入幂等键。
- 同一输入正在处理、已经回复或被明确放弃时，不重复创建 Runtime turn。

### 4.2 Runtime 编排

一个 `chatserver-agent` 只承载一个 Agent 身份。生产装配不再使用 `idleRuntime`，
而是使用单 Agent Runtime Manager。Host 为每次有效平台/IM Session 创建
`launchEpoch`；Runtime 输入必须显式携带该 epoch：

```text
腾讯 IM message
  → Host（session/launch fencing/reconnect）
  → ReplyPolicy
  → Processing Ledger
  → Runtime Manager
      ├─ Codex app-server
      └─ Hermes Gateway
  → 受控 raft message capability
  → IMTransport.SendText / SendCustom
```

Runtime Manager 负责：

- 从 Runtime Session 读取 `kind/model`，拒绝未知 Runtime。
- 探测二进制与必要配置，错误必须可诊断，不能回落到另一个 Runtime。
- 同一腾讯会话严格顺序投递；不同会话可以并行排队，但单 Runtime 是否并发由 Driver
  policy 决定。Host 不再为同会话中的每条消息直接启动独立 goroutine。
- Runtime busy 时使用该 Driver 明确支持的 steer 语义。
- 记录 Runtime session ID，以便进程存活期间恢复上下文。
- stop、credential 失效或 launch 被替换时优雅关闭，超时后强制终止。
- 所有事件携带 launch epoch。launch 轮换时必须先吊销旧 Gateway token，再关闭旧
  Runtime；旧 epoch 的回复能力立即失效。

### 4.3 显式发送能力

模型不会因为产生 assistant 输出而自动向聊天发送内容。每次 Runtime launch 注入：

- 本地回环 Capability Gateway 地址；
- 每 launch 独立的随机 token；
- 当前 Agent、Server、来源 Conversation 和来源 MessageRef；
- 名为 `raft` 的 Agent-facing 包装命令。

首版仅需：

```text
raft message reply --text <text>
```

Gateway 必须验证：

- token 属于当前 launch 且未过期；
- launch epoch 仍是当前值；
- reply 的目标等于本次输入的来源会话；
- 文本非空且不超过腾讯 IM 与平台设定的上限；
- `(inputMessageRef, launchEpoch, actionKey)` 没有成功发送过。

`actionKey` 由 wrapper 为一次工具调用生成随机 UUID，并在同一次调用重试时保持不变。
Gateway 不接受模型指定的 actionKey。发送成功后只保存腾讯消息引用和处理结果，
不保存回复正文。

### 4.4 本地 Processing Ledger

Agent 本地需要一个小型、持久、非聊天数据库的处理账本，分为两类记录。

输入处理记录：

```text
input_key
conversation_address
source_message_id
launch_epoch
state = accepted | running | completed | failed_retryable | abandoned
runtime_session_id（可空）
attempt
updated_at
```

发送动作记录：

```text
input_key
launch_epoch
action_key
state = reserved | sending | sent | outcome_unknown | failed
outbound_message_id（可空）
updated_at
```

`(input_key, launch_epoch, action_key)` 唯一。发送前先持久化 `sending`，成功回执后改为
`sent`；如果腾讯调用结果不确定或发送后在落盘前崩溃，则恢复为
`outcome_unknown`，不得自动重发。v1 提供的是 at-most-once 自动回复：极端故障可能
少回复，但不能为了追求回复率静默制造重复消息。只有明确确认“请求未到达腾讯”时才可
进入 `failed` 并由同一 actionKey 重试。

它只解决 Runtime 副作用幂等、崩溃恢复和旧 launch fencing，不承担消息历史查询。
正文、UserSig、Runtime Credential、模型提示词和模型输出不得写入账本。

## 5. PTY 会话签发

### 5.1 后台端口

应用层依赖供应商无关端口：

```go
type TerminalSessionIssuer interface {
    Issue(ctx context.Context, target TerminalTarget) (TerminalSession, error)
}
```

`TerminalTarget` 只包含平台已验证的 Computer/TAT 定位：

```text
computerId, tatRegion, tatInstanceKind, tatInstanceId, osType
```

公开 TAT Go SDK 没有 Session 创建方法，macapp 中的
`POST /sandboxes/{sandboxId}/tat/session` 只证明数据面签发结果和握手，不作为
chatserver 的稳定上游接口。生产实现调用平台内部的 TAT Session Issuer Gateway：

```http
POST /v1/tat/terminal-sessions
Authorization: Bearer <service-token>
Content-Type: application/json

{
  "computerId": "019...",
  "region": "ap-shanghai",
  "instanceKind": "managed",
  "instanceId": "rins-...",
  "osType": "linux"
}
```

Issuer Gateway 负责把稳定 TAT locator 解析为供应商内部 `sandboxId/poolId`，并返回
经过 macapp 已验证的 TerminalSession 数据。BaseURL 与 service token 只来自后台
进程配置和权限 `0600` 的密钥文件；不进入数据库、命令输出或前端。上游稳定错误归一为：

```text
terminal_target_not_found
terminal_target_offline
terminal_rate_limited
terminal_session_unavailable
terminal_session_rejected
terminal_response_invalid
```

测试与本地开发使用同一端口的 fake 实现；未配置生产 Gateway 时路由返回明确的
`terminal_session_unavailable`，不得伪造 WSS。

### 5.2 平台 HTTP 契约

保留：

```http
POST /servers/{serverId}/computers/{computerId}/terminal-sessions
Authorization: Bearer <human-token>
```

请求者必须是 Server Owner/Admin，Computer 必须 active 且 TAT Agent online。
成功响应：

```json
{
  "protocol": "tencent-tat-pty-v1",
  "sessionId": "s-...",
  "webSocketUrl": "wss://...",
  "expiresAt": "2026-07-30T16:00:00Z",
  "authentication": {
    "uin": "100000000001",
    "appId": 1250000000,
    "instanceId": "rins-..."
  },
  "terminal": {
    "cols": 120,
    "rows": 32,
    "maxIdleSeconds": 3600
  }
}
```

响应必须带：

```http
Cache-Control: no-store
Pragma: no-cache
```

不返回 `sandboxId`、`poolId`、`loginUin`、region 或平台访问上游使用的 Bearer。
后台不保存 `webSocketUrl`、终端认证载荷或终端字节；日志只记录 request ID、
account ID、server ID、computer ID、结果代码和耗时。

### 5.3 TAT PTY 文本帧

WebSocket 建立后，客户端按顺序：

1. 发送 `SessionAuth`。
2. 发送 `PtyStart`，默认 shell，不设置 `NoShell`。
3. 等待 `PtyReady` 后进入原始终端模式。
4. stdin → Base64 → `PtyInput`。
5. `PtyOutput` → Base64 解码 → stdout。
6. 终端尺寸变化时发送 `PtyResize`。
7. 空闲期间使用 `PtyPing/PtyPong`。
8. 正常退出发送 `PtyStop`，然后关闭 WebSocket。

完整 v1 帧：

```json
{"Type":"SessionAuth","Data":{"Uin":"owner-uin","AppId":1250000000,"InstanceId":"rins-...","SessionId":"s-..."}}
{"Type":"PtyStart","Data":{"SessionId":"s-...","ChannelId":"随机 UUID","Cols":120,"Rows":32}}
{"Type":"PtyReady","Data":{"SessionId":"s-...","ChannelId":"随机 UUID"}}
{"Type":"PtyInput","Data":{"SessionId":"s-...","ChannelId":"随机 UUID","Input":"Base64"}}
{"Type":"PtyOutput","Data":{"SessionId":"s-...","ChannelId":"随机 UUID","Output":"Base64"}}
{"Type":"PtyResize","Data":{"SessionId":"s-...","ChannelId":"随机 UUID","Cols":160,"Rows":48}}
{"Type":"PtyPing","Data":{"SessionId":"s-...","ChannelId":"随机 UUID"}}
{"Type":"PtyPong","Data":{"SessionId":"s-...","ChannelId":"随机 UUID"}}
{"Type":"PtyStop","Data":{"SessionId":"s-...","ChannelId":"随机 UUID"}}
{"Type":"PtyError","Data":{"SessionId":"s-...","ChannelId":"随机 UUID","Reason":"..."}}
```

`SessionId + ChannelId` 是数据面路由键。未知帧忽略并记录类型；`PtyError`、
认证失败、会话过期、网络关闭和本地信号都必须退出原始模式并恢复终端。
`authentication.uin` 明确映射上游 `ownerUin`，不能使用 `loginUin`。

## 6. 错误、并发与安全

- 后台看不到客户端 WSS 的可靠关闭事件，因此 v1 只实施 Account/Computer 维度的
  “会话签发频率限制”，不声称严格限制活跃 PTY 数量。
- 会话签发不能使用通用 HTTP 幂等缓存，因为每次成功都必须产生新短期会话。
- 上游超时、Computer 离线、权限不足、上游拒绝和签发配置缺失使用稳定平台错误码。
- PTY Session 响应不进入应用缓存、访问日志正文、错误详情或客户端持久存储。
- TUI 在进程退出、`SIGINT`、`SIGTERM` 和 WebSocket 失败时恢复 stdin 模式。
- Capability Gateway 只监听 `127.0.0.1`，拒绝外部监听和上游重定向。
- token、UserSig、Runtime Credential、终端输入输出和模型正文不进入测试 fixture。

## 7. 测试与验收

### 7.1 Agent

- fake IM + fake Runtime 覆盖三种 `replyPolicy`、自发消息、重复消息和未知元素。
- fake Codex app-server 覆盖 start/resume/steer、显式 reply、崩溃、空输出和终止。
- fake Hermes Gateway 覆盖连接、会话、显式 reply、断线和不可用，不允许 ACP 回退。
- Capability Gateway 覆盖无 token、过期 token、旧 launch、越权会话、重复 action。
- 进程崩溃后重放同一腾讯 messageId 不重复发送成功副作用。
- 真实 Canary：Human 发消息，Agent 显式回复，回复可由另一个 Human IM 客户端收到。

### 7.2 PTY

- fake Issuer 覆盖权限、Computer 离线、上游失败、响应脱敏和 no-store。
- fake WebSocket 覆盖 `SessionAuth → PtyStart → PtyReady` 顺序。
- 覆盖 Base64 输入输出、resize、ping/pong、PtyError、过期、异常关闭和信号退出。
- 验证 TUI 退出后终端属性恢复。
- 真实 Canary：由 Go 后台签发 managed `rins-*` 会话，TUI 运行
  `printf 'tat-canary-ok\n'` 并正确退出。

### 7.3 共享客户端

- TUI 聊天命令不得经过 Go 后台消息代理。
- TUI 终端命令不得持有或调用 CAM/TAT 管理凭据。
- `PlatformPort`、`MessagingPort`、`TerminalPort` 可以被无 Ink 的单元测试调用。
- Go `go test -race ./...`、TypeScript typecheck、单测和凭证扫描全部通过。

## 8. 实施顺序

1. 修订 OpenAPI `TerminalSession`，重新生成 Go 与 TypeScript 类型。
2. 实现后台 `TerminalSessionIssuer`、应用服务与 HTTP Handler，先用 fake 完成测试。
3. 实现共享 TypeScript `TerminalPort` 和 TAT PTY 状态机。
4. 实现 Node 原始终端适配器与 `terminal` 命令。
5. 先修改 Host 的 launch context 与同会话顺序语义，并实现 Processing Ledger、
   Capability Gateway 和 `raft message reply` 包装命令。
6. 将 clean-room Runtime 核心按 chatserver 边界迁入，先 Codex、后 Hermes Gateway。
7. 用真实腾讯 IM 和 TAT Canary 分别验收两个闭环。
