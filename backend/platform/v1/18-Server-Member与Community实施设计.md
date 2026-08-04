# Server、Owner Member 与 Community 实施设计

## 1. 目标

在已经完成的 Human 注册、登录、IM 身份和 UserSig 基础上，实现首个 Server 业务
闭环：

```text
当前 Human
→ 创建 Server
→ 自动成为 Owner Member
→ 创建 #全员 根 Channel
→ 异步创建腾讯 Community
→ 10 秒内完成则同步返回 ready
→ 否则返回 provisioning 并由 Worker 继续收敛
```

本设计不增加数据库表，复用现有 Server、Member、Channel、
AccountServerMembership、ServerSlugRegistry、TencentOperation、OutboxEvent 与
IdempotencyRecord。

## 2. 范围

### 2.1 实现

- `POST /v1/servers`；
- `GET /v1/servers`；
- `GET /v1/servers/{serverId}`；
- `GET /v1/servers/{serverId}/members`；
- `GET /v1/servers/{serverId}/members/{memberId}`；
- `im.community.ensure` Worker；
- 腾讯云 Community 创建与存在性对账；
- 真实腾讯云 Human + Community Canary。

### 2.2 不实现

- Invite 与第二位 Human 加入；
- Member 更新、移除、退出或 Owner 转让；
- 普通 Channel/Topic 创建；
- Private Topic membership；
- Server 更新、删除或 Community 解散；
- Agent、Computer、Task、Reminder；
- 平台消息存储和自研 WebSocket。

## 3. 固定原则

### 3.1 同步体验、异步正确性

HTTP 请求不直接持有数据库事务调用腾讯云。创建分为两阶段：

1. 本地事务建立全部平台事实和可靠 Operation；
2. Worker 在事务外调用腾讯云并把结果收敛回数据库。

本地事务提交后，HTTP 最多等待 10 秒：

- Operation 在窗口内成功：返回 `201` 和完整 Server；
- 尚未完成：返回 `202` 和 AcceptedResource；
- 窗口内已经进入终态失败：返回稳定 ErrorEnvelope，同时 Server 仍可查询为
  `error`；
- 客户端断开只停止等待，不取消 Worker。

等待采用有界数据库状态查询。不能只依赖进程内通知，因为未来 API 与 Worker 可以
运行在不同副本。

### 3.2 腾讯对象映射

```text
Server             → 支持 Topic 的 Community
Owner Human Member → Community Owner
#全员 Channel       → Community 根会话
普通 Channel       → Topic（不属于本切片）
```

`#全员` 的 `im_topic_id` 永远为 NULL。创建 Server 不额外创建 Topic。

### 3.3 平台事实优先

Server、Member、Channel、slug 和账号投影是平台业务事实；腾讯云只承载 IM 资源。
腾讯调用失败不回滚已经提交的平台资源，也不建立第二套聊天数据库。

## 4. 创建事务

### 4.1 输入

`POST /v1/servers` 使用现有 CreateServerRequest：

```json
{
  "slug": "agent-lab",
  "name": "Agent 实验室",
  "description": "可选"
}
```

要求：

- 当前主体为有效 Human Access Token；
- Account 存在且 `im_state=ready`；
- Account 的 `im_user_id` 非空；
- Idempotency-Key 必填并符合现有长度限制；
- slug 已标准化且全局未被占用；
- name 和 description 通过 OpenAPI 校验。

### 4.2 同一事务写入

Repository 的 `Create` 是一个应用端口，不向应用层暴露 Ent。v1 只实现 SQLite，
全部写入使用现有 `database.Handle.WithTx` 在一个本地事务内完成：

```text
BEGIN
→ 校验 Account
→ 写 Server/Member/Channel
→ 写 SlugRegistry/AccountServerMembership
→ 写 TencentOperation/Outbox/IdempotencyRecord
COMMIT
```

应用代码不实现 2PC coordinator、XA、Saga 或跨库补偿。

未来迁移 TDSQL 时，这个低频事务会跨 accountId、slug、serverId 三种逻辑路由。
优先使用 TDSQL MySQL 对客户端透明的原生分布式事务，Repository 接口和应用服务
不变。是否把 AccountServerMembership 改成异步投影，只在真实 TDSQL 压测证明该
低频事务成为瓶颈后再决定，不进入 v1 实施或验收范围。

事务写入：

1. ServerSlugRegistry：
   - UUIDv7 id；
   - slug；
   - serverId；
   - state=`active`。
2. Server：
   - UUIDv7 serverId；
   - slug=规范化请求 slug；
   - name=请求 name；
   - description=请求 description；
   - 稳定派生 `im_group_id`；
   - `im_state=provisioning`；
   - `next_task_number=1`；
   - `revision=1`；
   - ownerMemberId。
3. Owner Member：
   - UUIDv7 memberId；
   - serverId；
   - accountId；
   - kind=`human`；
   - role=`owner`；
   - displayName=Account.displayName；
   - handle=稳定 Human handle；
   - status=`active`；
   - `im_state=provisioning`；
   - `revision=1`。
4. `#全员` Channel：
   - UUIDv7 channelId；
   - serverId；
   - name=`全员`；
   - visibility=`public`；
   - systemKey=`all`；
   - imGroupId=Server.imGroupId；
   - imTopicId=NULL；
   - `im_state=provisioning`；
   - `revision=1`。
5. AccountServerMembership：
   - UUIDv7 id；
   - accountId；
   - serverId；
   - memberId；
   - role=`owner`；
   - status=`active`；
   - Server name/slug/revision 快照；
   - projectedAt=事务统一 now。
6. TencentOperation：
   - UUIDv7 operationId；
   - service=`im`；
   - kind=`im.community.ensure`；
   - partitionKey=serverId；
   - serverId=serverId；
   - resourceType=`server`；
   - resourceId=serverId；
   - desiredRevision=1；
   - state=`pending`；
   - attempts=0；
   - idempotencyKey=`im.community.ensure:v1:<serverId>:1`。
7. OutboxEvent：
   - UUIDv7 id；
   - partitionKey=serverId；
   - serverId=serverId；
   - eventType=`tencent.operation.ready`；
   - aggregateType=`tencent_operation`；
   - aggregateId=operationId；
   - state=`pending`；
   - attempts=0；
   - availableAt=事务统一 now。
8. IdempotencyRecord：
   - UUIDv7 id；
   - partitionKey=accountId；
   - scopeType=`server.create`；
   - scopeId=accountId；
   - idempotencyKey=请求 Header；
   - requestHash 覆盖规范化请求；
   - responseStatus=202；
   - responseBodyJson=只含稳定 serverId/operation 的 AcceptedResource；
   - expiresAt=now+24h。

任一步失败都回滚。slug 冲突返回稳定 `server_slug_conflict`。

所有业务表 id 由 Ent 的 UUIDv7 Mixin 生成。事务必须使用一个统一 UTC `now`，不能
为同一提交中的 availableAt/projectedAt 分别取时钟。

### 4.3 Owner handle

首个 Human handle 不使用邮箱或 displayName。固定算法：

```text
input  = LP("human-member") || LP(accountId) || LP(memberId)
handle = "u_" + BASE32-NO-PADDING(SHA256(input))[0:20]
```

handle 只由不透明 UUIDv7 产生，不包含个人信息。若极小概率触发
`UNIQUE(server_id, handle)`，整个事务回滚并重新生成 memberId，最多重试三次；之后
返回安全的 internal_error。

### 4.4 Idempotency-Key

同一 Account、同一 Idempotency-Key：

- requestHash 相同：始终返回同一 serverId；
- requestHash 不同：返回 `idempotency_conflict`；
- Operation 未完成：可继续等待剩余 10 秒窗口；
- Operation 已成功：返回当前 `201` Server；
- Operation 已终态失败：返回相同稳定失败。

幂等保证的是资源与副作用唯一，不要求异步收敛前后的 HTTP 状态码永远相同。
IdempotencyRecord 的 `response_status=202/response_body_json` 是永久稳定的资源
locator，不是异步资源的当前状态快照，也不由 serverId 分片的 Worker 跨分片改写。
重复请求先在 accountId 分片命中 locator，再按 operationId/serverId 查询当前状态，
动态返回 201、202 或终态失败。该 operation 是现有“普通写命令保存稳定响应”规则的
异步资源特例，必须由 202→201、202→失败测试固定。

## 5. Community 标识

复用 `07-腾讯云IM适配.md` 的资源标识算法：

```text
GroupId = "@TGS#_C_" + BASE32(HMAC-SHA256(resourceSubkey, ...))[0:26]
```

规则：

- resourceSubkey 与 Human identity key 分离；
- key 文件必须为普通文件、非符号链接、权限 `0600`、恰好 32 bytes；
- GroupId 创建后持久化，以数据库为准；
- key 轮换不重算已有 GroupId；
- 派生实现必须用冻结 fixture 验证。

## 6. Community Worker

### 6.1 Port

新增独立的 Community 端口，不把腾讯 HTTP 细节泄漏到应用层：

```text
CommunityProvisioner.Ensure(ctx, CommunitySpec) error
CommunityInspector.Get(ctx, groupId) (CommunityFact, found, error)
```

CommunitySpec 只包含：

- GroupID；
- OwnerUserID；
- Name；
- Introduction。

### 6.2 腾讯请求

调用：

```text
POST /v4/group_open_http_svc/create_group
```

请求固定为：

```json
{
  "Owner_Account": "<stored human im user id>",
  "Type": "Community",
  "GroupId": "<stable group id>",
  "Name": "<utf8-safe name>",
  "Introduction": "<utf8-safe optional description>",
  "ApplyJoinOption": "DisableApply",
  "InviteJoinOption": "DisableInvite",
  "SupportTopic": 1,
  "EnablePermission": 0
}
```

Name 最大 100 UTF-8 bytes，Introduction 最大 400 UTF-8 bytes；平台保留原始完整
字段，腾讯请求使用确定性的 UTF-8 安全截断值。

不发送 MemberList。官方语义保证填写 Owner_Account 后 Owner 自动加入群。

### 6.3 领取与 fencing

沿用 Human IM Worker 的安全模型：

- 短 lease；
- attempt 计数；
- 过期 operation 可重领；
- 调用腾讯前回读 Server、Owner Member、Account；
- desiredRevision 不匹配时 superseded；
- lease owner、lease expiry、desiredRevision 三重 fencing；
- 外部调用完成后重新获取完成时间；
- 旧 Worker 永远不能覆盖新结果。

### 6.4 错误分类

可重试：

- 网络错误；
- HTTP 429、5xx；
- 腾讯 `10002`；
- 腾讯 `10006`；
- 可安全确认未完成的临时错误。

永久失败：

- 参数非法；
- 签名、管理员或权限配置错误；
- Community/Topic 功能未开通；
- 套餐和群数量限制；
- Owner UserID 不存在；
- GroupId 冲突且对账不匹配。

错误只保存稳定 code，不保存 ErrorInfo、UserSig、URL query 或原始响应正文。

### 6.5 `10025` 对账

腾讯返回 `10025` 时，不能直接成功或继续 create：

1. 调用 `get_group_info` 查询指定 GroupId；
2. 验证：
   - GroupId 完全相同；
   - Type=`Community`；
   - Owner_Account 与当前持久化 Human UserID 相同；
   - 支持 Topic；
3. 全部匹配：按幂等成功处理；
4. 查不到或事实不匹配：终态 `im_group_conflict`。

`10021` 表示 GroupId 被其他主体使用，直接进入终态冲突。

### 6.6 完成事务

成功时同一事务：

- Server.im_state=`ready`；
- Owner Member.im_state=`ready`；
- `#全员` Channel.im_state=`ready`；
- 三者 revision 按现有状态机递增；
- TencentOperation=`succeeded`；
- 对应 Outbox processed。

重试时：

- 三个资源保持 provisioning；
- Operation=`retry_wait`；
- 指数退避并设置 nextAttemptAt。

终态失败时：

- 三个资源进入 error；
- Operation=`failed`；
- 保存稳定 lastErrorCode；
- Outbox processed。

## 7. HTTP 响应

OpenAPI 为 createServer 增加：

```text
201 → Server
202 → AcceptedResource
```

OpenAPI 修改和 oapi-codegen 重新生成是本切片的第一项实现任务；在生成的 strict
`CreateServerResponseObject` 能表达 201 之前，不得实现生产 handler。

10 秒是服务端配置默认值，测试中可注入；不暴露为客户端 query 参数。

等待期间：

- 只查询 operation/resource 状态；
- 不持有数据库事务或 SQLite Writer；
- 不持有腾讯 REST response；
- request context 取消只结束等待；
- Worker 使用进程生命周期 context。

终态失败使用稳定错误码：

- `server_slug_conflict`；
- `account_im_not_ready`；
- `im_community_unavailable`；
- `im_group_conflict`；
- `idempotency_conflict`。

## 8. 查询与授权

### 8.1 `GET /v1/servers`

- 只接受 HumanBearer；
- 先按 accountId 查询 AccountServerMembership；
- 只返回 active projection；
- 结果按稳定 cursor 分页；
- v1 SQLite 可按 serverId 批量补全 Server；
- 未来 TDSQL 由应用层对分页内 serverId 做有界并行点查，不做无界跨分片 SQL。

### 8.2 Server 与 Member 查询

以下请求先验证当前 Account 在目标 Server 中存在 active Human Member：

- `GET /v1/servers/{serverId}`；
- `GET /v1/servers/{serverId}/members`；
- `GET /v1/servers/{serverId}/members/{memberId}`。

然后按 serverId 点查业务资源。非 Member、removed Member、跨 Server memberId 统一
返回不泄漏目标存在性的稳定错误。

本切片不开放 Owner 修改、删除、退出或转让。

## 9. 进程装配

现有 `serve` 扩展为：

```text
HTTP API
├── Auth/Human API
├── Server/Member API
├── IM Identity Worker
└── IM Community Worker
```

两个 Worker 共用：

- SQLite Handle；
- 管理员 UserSig issuer；
- 安全配置；
- 进程 cancel/join；
- REST client 基础认证组件。

但分别拥有 Port、Repository、Service 和 operation kind，不能用 type switch 组成一个
巨型 Worker。

Shutdown 顺序：

1. 停止接收新 HTTP 请求；
2. HTTP graceful shutdown；
3. 取消 Worker context；
4. 等待两个 Worker join；
5. 关闭数据库。

## 10. 真实 Canary

Canary 使用独立临时 SQLite 和唯一随机资源：

```text
注册随机 Human
→ 等待 account_import ready
→ 获取 Human UserSig
→ POST /servers
→ 等待真实 Community ready
→ GET /servers
→ GET Server
→ GET Owner Member
→ 校验数据库没有聊天消息正文
```

固定安全规则：

- 不读取或修改其他运行实例的 SQLite；
- SDKAppID 可作为普通配置；
- SecretKey 只从 `0600` 普通文件读取；
- UserSig、SecretKey 不进入命令参数、日志、测试 fixture 或计划文件；
- 默认管理员 UserID 使用 `administrator`；
- 若管理员身份失败则停止，不猜测其他管理员；
- Canary Server 使用唯一 slug；
- Canary Community 默认保留供控制台检查；
- 不自动解散或删除外部资源。

## 11. 测试

### 11.1 应用和 Repository

- 创建事务完整写入或完整回滚；
- SQLite 取消、panic 和冲突均完整回滚；
- slug 冲突；
- Account IM 未 ready；
- Idempotency-Key 相同请求复用；
- 相同 key 不同请求冲突；
- AccountServerMembership 投影正确；
- Server/Member 授权与跨 Server 隔离。

### 11.2 腾讯 Adapter

- create_group URL/query/body；
- Owner 自动成员的请求不重复发送 MemberList；
- UTF-8 byte 安全截断；
- HTTP 200 业务错误；
- 429/5xx/网络错误；
- redirect 拒绝；
- `10025` 后 get_group_info 匹配/不匹配；
- 响应和错误不泄漏敏感字段。

### 11.3 Worker

- 成功；
- retry_wait 与最大次数；
- 永久失败；
- expired lease；
- stale revision；
- old owner 写回；
- ready 事实跳过副作用；
- `10025` 对账恢复；
- HTTP request 取消后继续执行。

### 11.4 HTTP 和端到端

- 10 秒内 201；
- 超时 202；
- 终态失败；
- 重复请求；
- 未认证和非 Member；
- list/get Server；
- list/get Member；
- fake 腾讯完整闭环；
- 真实腾讯 Canary。

### 11.5 最终门禁

- `go test ./...`；
- `go test -race ./...`；
- `go vet ./...`；
- OpenAPI lint；
- fixture JSON 校验；
- `go mod verify`；
- 凭证扫描；
- Ent/OpenAPI 生成漂移检查；
- gofmt。

v1 不包含 TDSQL 连接、XA/coordinator 或跨分片故障注入测试。

## 12. 验收

- 一个新 Human 能创建 Server 并自动成为 Owner Member；
- 同一个请求不会创建第二个平台 Server 或腾讯 Community；
- 创建接口在腾讯快速成功时返回 201，慢或仍处于可重试故障时在 10 秒内返回 202；
- 已进入永久失败的创建请求返回稳定 ErrorEnvelope，不伪装为仍在执行；
- Worker 在请求结束后继续重试并最终收敛；
- Server、Owner Member、`#全员` 三者 IM 状态一致；
- `#全员` 使用 Community 根会话，不产生额外 Topic；
- 非 Member 不能读取 Server 或 Member；
- 真实腾讯控制台可见一个支持 Topic 的 Canary Community；
- 真实 Owner Human 已在 Community 中；
- 仓库、日志和数据库不包含 SecretKey、UserSig 或普通聊天消息正文。

## 13. 官方依据

- [腾讯云创建群组](https://cloud.tencent.com/document/api/269/1615?lang=zh)
- [腾讯云增加群成员](https://cloud.tencent.com/document/api/269/1621)
- [腾讯云 REST API 接口列表](https://cloud.tencent.com/document/product/269/1520)
