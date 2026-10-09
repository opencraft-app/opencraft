# HTTP API 设计

## 1. 约定

- 前缀：`/v1`
- JSON：camelCase
- 时间：RFC 3339 UTC
- 非 Secret 写操作使用 `Idempotency-Key`
- 更新使用 `X-Resource-Revision`，成功写入在响应同名 header 返回新 revision
- 分页使用 `limit + cursor`
- 异步腾讯云操作返回 `202 + operationId`
- 错误结构：`{error:{code,message,requestId,details?}}`
- Server 路径中的 serverId 同时是 TDSQL shardkey；
- Repository 不允许从 URL 中丢弃 serverId 后只按资源 id 查询。

普通聊天、历史、未读和附件直接使用腾讯云 IM SDK。平台不提供消息镜像 API，也
没有 WebSocket/Socket.IO 入口。

异步操作可通过下列接口对账：

```text
GET /servers/{serverId}/operations/{operationId}
```

查询同时校验当前 Human 的 active Server membership，并始终携带 `serverId` 访问
同一业务分片。

## 2. Auth 与 Human IM Session

```text
POST /auth/register
POST /auth/login
POST /auth/refresh
POST /auth/logout
GET  /me
POST /me/im/session
```

`POST /me/im/session` 返回全局 Human IM 身份：

```json
{
  "sdkAppId": 1600000000,
  "userId": "u_01...",
  "userSig": "<short-lived-secret>",
  "expiresAt": "2026-07-29T04:00:00Z"
}
```

它不接受 serverId。客户端只登录一次腾讯 SDK。

认证 v1 固定语义：

- 密码以 Argon2id PHC 字符串保存，不保存或记录明文；
- Access Token 是短期 HS256 JWT，绑定 accountId、authSessionId 和 tokenVersion；
- Refresh Token 使用
  `rt1.<accountId>.<sessionId>.<32-byte-random-base64url>`；
- Refresh Token 前缀只用于选择 accountId 分片，授权依据仍是完整 token 的
  SHA-256 与 AuthSession 当前状态；
- refresh token 单次使用；成功轮换会消费旧 AuthSession，并在同一 family 创建
  新 AuthSession；旧 token 重放会撤销整个 family；
- 注册事务原子创建 AccountLoginIdentity、Account、首个 AuthSession、
  `im.identity.ensure` TencentOperation 和 `tencent.operation.ready` Outbox；
- 重复邮箱返回 `account_already_exists`；账号不存在与密码错误都返回
  `unauthenticated`。

## 3. Server 与 Member

```text
GET    /servers
POST   /servers
GET    /servers/{serverId}
PATCH  /servers/{serverId}
GET    /server-slugs/{slug}

GET    /servers/{serverId}/invites
POST   /servers/{serverId}/invites
DELETE /servers/{serverId}/invites/{inviteId}
POST   /invites/accept

GET    /servers/{serverId}/members
GET    /servers/{serverId}/members/{memberId}
PATCH  /servers/{serverId}/members/{memberId}
DELETE /servers/{serverId}/members/{memberId}
```

Member 的 `imUserId` 是投影字段：Human 从 Account 读取，Agent 从 Agent 读取。

`GET /servers` 读取 accountId 分片内的 AccountServerMembership 投影；进入 Server
或执行写操作时仍按 serverId 点查权威 Member。`GET /server-slugs/{slug}` 先读取
slug 分片 registry，再按 serverId 获取 Server。slug 创建后不可修改。

Invite Token 使用
`inv_<serverId>.<inviteId>.<randomSecret>`，以便接受邀请时直接路由 Server 分片。

## 4. Channel

```text
GET    /servers/{serverId}/channels
POST   /servers/{serverId}/channels
GET    /servers/{serverId}/channels/{channelId}
PATCH  /servers/{serverId}/channels/{channelId}
GET    /servers/{serverId}/channels/{channelId}/members
PUT    /servers/{serverId}/channels/{channelId}/members/{memberId}
DELETE /servers/{serverId}/channels/{channelId}/members/{memberId}
```

`#全员` 不允许通用 join/leave。普通 Public Channel 允许 Server Member 对自己执行 PUT
主动加入；Private Channel 的 PUT 仅允许 Owner/Admin。普通成员可对自己执行 DELETE 退出。
visibility 创建后不可修改。

## 5. Agent

```text
GET    /servers/{serverId}/agents
POST   /servers/{serverId}/agents
GET    /servers/{serverId}/agents/{agentId}
PATCH  /servers/{serverId}/agents/{agentId}
DELETE /servers/{serverId}/agents/{agentId}

POST /servers/{serverId}/agents/{agentId}/deploy
POST /servers/{serverId}/agents/{agentId}/start
POST /servers/{serverId}/agents/{agentId}/stop
POST /servers/{serverId}/agents/{agentId}/restart
POST /servers/{serverId}/agents/{agentId}/credentials/rotate
```

创建/更新允许的 Runtime 字段：

```json
{
  "computerId": "0198f4c2-7a35-7f14-86ab-2e57552e473f",
  "runtime": {"kind": "codex", "model": "default"},
  "replyPolicy": "mention_and_dm"
}
```

`POST` 创建时 `computerId` 必填且不可为 `null`。它必须指向同 Server、已纳管且 active
的 Computer；Computer 暂时离线不影响建立归属。`PATCH` 省略 `computerId` 表示不修改，
提供另一个 ID 表示在 Agent 停止态迁移；不支持解绑。

不得接受 shell command、args、env、绝对路径、腾讯云密钥或 UserSig。生命周期操作
返回 TencentOperation；credential 只通过 TAT 写入 Computer，不在 HTTP 响应中
返回明文。

Agent 查询同时返回：

```text
availability           unknown | online | offline
imPresence             unknown | online | offline
imPresenceUpdatedAt
hostLastSeenAt
```

`availability` 是 IM 当前状态、Runtime Session 最近活跃和 TAT 生命周期的派生值，
不是新的长连接协议。

## 6. Agent Runtime Session

```text
GET  /runtime/me
```

Runtime 短期会话不再由 Agent 自带长期凭证换取。Computer 先以当前
`ComputerBearer` 和 Assignment fence 调用：

```text
POST /computer/agents/{agentId}/launches
POST /computer/agents/{agentId}/launches/{launchId}/session
```

两条响应为当前 launch 签发短期 Runtime access token 与 Agent IM UserSig：

```http
Authorization: Bearer <short-lived-computer-token>
```

返回：

```json
{
  "accessToken": "<short-lived-runtime-token>",
  "expiresAt": "2026-07-29T04:00:00Z",
  "agent": {
    "id": "0198f4c2-7a33-79f2-8cd1-8ad6b57f7d1b",
    "serverId": "0198f4c2-7a31-7c91-a6d2-7d76f9188c38",
    "userId": "a_01...",
    "replyPolicy": "mention_and_dm",
    "runtime": {"kind": "codex", "model": "default"}
  },
  "im": {
    "sdkAppId": 1600000000,
    "userSig": "<short-lived-secret>",
    "expiresAt": "2026-07-29T04:00:00Z"
  }
}
```

Runtime 到期前由 Computer 使用当前 launch fence 刷新；旧 launch、旧 generation、旧
credential version 均被拒绝。Runtime token 不能访问其他 Agent 或 Server。

正式进程在同一个 HTTPS 端口提供 Human 与 Runtime API；`/v1/runtime/*` 只使用独立的
RuntimeBearer 认证链，其余管理接口使用 HumanBearer。路径分流不
允许任一凭据跨认证域降级使用。

Runtime credential 使用
`arc_<serverId>.<agentId>.<version>.<randomSecret>`。服务端解析 serverId 后仍须
验证完整哈希、credential version、状态和 Agent 当前性。

## 6.1 腾讯 IM 状态回调

```text
POST /callbacks/tencent-im/state
```

该路径不使用 Human/Runtime Bearer，只接受腾讯云
`CallbackCommand=State.StateChange`，并校验 SDKAppID、独立 Callback Token 签名和
60 秒 RequestTime 时间窗。未配置 Callback Token 时不注册此路由。

## 7. Computer 与 TAT

```text
GET    /servers/{serverId}/computers
POST   /servers/{serverId}/computers
GET    /servers/{serverId}/computers/{computerId}
PATCH  /servers/{serverId}/computers/{computerId}
DELETE /servers/{serverId}/computers/{computerId}

POST /servers/{serverId}/computers/{computerId}/registration
POST /servers/{serverId}/computers/{computerId}/refresh
POST /servers/{serverId}/computers/{computerId}/terminal-sessions
```

原生实例创建：

```json
{
  "name": "生产执行机-01",
  "tatRegion": "ap-shanghai",
  "tatInstanceKind": "cvm",
  "tatInstanceId": "ins-..."
}
```

外部纳管创建：

```json
{
  "name": "办公室执行机-01",
  "tatInstanceKind": "managed",
  "osType": "linux"
}
```

托管实例的注册地域由后台部署策略选择（v1 默认 `ap-beijing`），客户端不能提交或
覆盖 `tatRegion`。创建响应与后续 `registration.region` 会返回后台选择的同一地域；
客户端仅持久化并校验该结果。

随后调用 `registration`，一次性获得短期结构化注册材料：

```json
{
  "protocol": "tencent-tat-register-v1",
  "region": "ap-shanghai",
  "registerCodeId": "<secret>",
  "registerCodeValue": "<secret>",
  "tags": [
    {
      "key": "agent-network-computer-id",
      "value": "0198..."
    }
  ],
  "expiresAt": "2026-07-31T13:00:00Z"
}
```

Computer 直接将材料传给内嵌 Rust TAT core，不执行注册 shell。该响应不得被日志、
缓存或 IdempotencyRecord 保存。

原生 Computer 创建和托管实例最终绑定都会预留
`SHA-256(tatRegion + 0x00 + tatInstanceId)`，防止同一 TAT 实例跨 Server 重复绑定。

`terminal-sessions` 调用 TAT `StartSession`，返回短期连接信息：

```json
{
  "sessionId": "s-...",
  "webSocketUrl": "wss://...",
  "expiresAt": "2026-07-29T03:15:00Z"
}
```

浏览器直接连接腾讯云 TAT；Go 后台不代理 PTY 流。

## 8. Task

```text
GET   /servers/{serverId}/tasks
POST  /servers/{serverId}/tasks
GET   /servers/{serverId}/tasks/{taskId}
PATCH /servers/{serverId}/tasks/{taskId}
```

Human Bearer Token 按 Member 权限创建、指派、观察和验收 Task，不提供领取接口。
Runtime Token 只能：

- 查询 ownerMemberId 等于当前 Agent 的 Task；
- 领取已经指派给自己的 Task；
- 更新当前 Agent 负责的 Task；
- 使用 `X-Resource-Revision` 和 `Idempotency-Key`；
- 不能把 owner 改为其他成员。

列表支持 `owner=me&updatedAfter=<cursor>`，供 Runtime 启动和重连对账。

## 9. Reminder

```text
GET    /servers/{serverId}/reminders
POST   /servers/{serverId}/reminders
GET    /servers/{serverId}/reminders/{reminderId}
PATCH  /servers/{serverId}/reminders/{reminderId}
DELETE /servers/{serverId}/reminders/{reminderId}

GET  /runtime/reminder-occurrences
POST /runtime/reminder-occurrences/{occurrenceId}/ack
```

Runtime 只查询自己的 due occurrence。ACK 使用 `Idempotency-Key`，重复确认返回相同
终态。

## 10. 腾讯云异步操作

```text
GET /servers/{serverId}/operations/{operationId}
```

公共响应只暴露：

```json
{
  "id": "op_01...",
  "service": "tat",
  "kind": "agent.start",
  "state": "running",
  "createdAt": "2026-07-29T03:00:00Z",
  "completedAt": null,
  "error": null
}
```

不返回腾讯云请求快照、Secret、脚本、UserSig 或内部响应原文。

## 11. 明确不存在的接口

```text
/messages
/attachments
/conversations
/sync
/agent-invocations
/agent-deliveries
/computer/session
/computers/connect
```

平台也不暴露任意 TAT RunCommand API。所有执行只能来自固定的 Agent 生命周期模板。

## 12. 信息暴露

- Member 可见 Server、Member、Agent、Channel、Task 基础信息；
- Computer、TAT、Runtime 配置和终端仅 Owner/Admin；
- UserSig、Runtime credential、TAT 注册材料和 PTY session 信息只在对应安全响应出现；
- 腾讯云管理员凭证永不进入 API；
- IM GroupId/TopicId 默认只提供给需要初始化 SDK 的已授权客户端；
- Runtime Token 不能枚举 Server 资源。
