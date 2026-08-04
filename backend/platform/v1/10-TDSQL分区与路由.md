# TDSQL 分区与路由

## 1. 基线

当部署选择水平扩展模式时，数据库固定为 TDSQL MySQL InnoDB 分布式版，要求支持
分布式事务的 5.7 或更高内核。本文件只约束该部署模式；SQLite 单机模式见
`04-数据库规格.md` 与 `11-SQLite数据基础实施设计.md`。Go 应用保持大单体，不在
应用层拆微服务或维护物理分片目录。

采用 TDSQL 原生 HASH 分表：

```sql
CREATE TABLE ... shardkey=<column>;
```

正式 DDL 必须遵守：

- INSERT 明确包含 shardkey；
- shardkey 不允许更新；
- shardkey 必须包含在主键和所有唯一索引中；
- 热路径查询必须带等值 shardkey；
- 不使用数据库外键、触发器、存储过程和自建分区；
- 字符串 shardkey 使用相同的 ASCII/binary 类型和排序规则；
- ID 由应用生成，不使用 TDSQL Sequence 作为高并发主键。

官方依据：

- [TDSQL 建表与 shardkey 规则](https://cloud.tencent.com/document/product/557/8767)
- [分表、单表、广播表与 Group-Shard](https://cloud.tencent.com/document/product/557/8765//)
- [TDSQL 使用限制](https://cloud.tencent.com/document/product/557/47511)
- [分布式事务](https://intl.cloud.tencent.com/zh/document/product/1042/33360)

## 2. 大单体落地

分布式数据库不等于拆微服务。v1 采用模块化大单体：

```text
一个 Go 仓库
└── 一个可执行文件
    ├── HTTP API
    ├── Tencent Worker
    ├── Outbox Relay
    └── Reminder Scheduler

一个 TDSQL 逻辑连接地址
```

- 应用不维护 set/shard 到连接池的映射；
- API、Worker、Scheduler 复用同一领域层和 Repository；
- Repository 接收 `PartitionContext{PartitionKey, Scope}`；
- 事务 helper 默认只允许一个 PartitionContext；
- 只有显式 `DistributedTx` API 能进入 2PC 白名单；
- 大单体实例本身无状态，可以横向扩容；
- 不以微服务、消息中台或应用层分库换取“未来可能需要”的复杂度。

## 3. 核心选择

### 3.1 Server Group-Shard

Server 是业务主体。所有属于一个 Server 的权威数据使用相同分片值：

```text
servers.id == 所有子表.server_id
```

`servers` 使用 `id` 作为 shardkey，子表使用 `server_id`。两列必须使用完全相同的
类型、字符集和排序规则。这样一个 Server 的 Member、Agent、Computer、Channel、
Task、Reminder 和腾讯云操作位于同一 set。

收益：

- 常规业务事务是单分片事务；
- Server 内 JOIN 是 Group-Shard 本地 JOIN；
- API 路径已有 serverId，无需额外路由查询；
- 一个大单体即可直接使用普通事务代码。

代价：单个超大 Server 不会被拆到多个 set。v1 接受这一边界，不提前设计
`server_id+bucket`，也不实现热门 Server 独立迁移。

### 3.2 Account Group-Shard

Account 及其登录会话使用：

```text
accounts.id
auth_sessions.account_id
account_server_memberships.account_id
```

作为同值 shardkey。Bearer Token 和 Refresh Token 都携带可验证的 accountId 路由
信息，所以登录后的请求不会全分片扫描。

### 3.3 通用基础设施分片键

`tencent_operations`、`idempotency_records` 和 `outbox_events` 使用统一
`partition_key`：

- Server 业务：`partition_key=server_id`；
- Account 业务：`partition_key=account_id`；
- 其他全局注册流程：使用其注册表 shardkey。

这样事实行和对应操作/Outbox 落在同一个 set，并在一个本地事务内提交。

## 4. 表类型矩阵

v1 正式共 26 张表，全部是 HASH 分表：

| 表 | shardkey | 主要访问入口 |
|---|---|---|
| `account_login_identities` | `login_hash` | 邮箱/手机号/OAuth 登录 |
| `accounts` | `id` | JWT accountId |
| `auth_sessions` | `account_id` | 可路由 Refresh Token |
| `account_server_memberships` | `account_id` | 我的 Server 列表投影 |
| `server_slug_registry` | `slug` | Server slug 解析和全局唯一 |
| `servers` | `id` | serverId |
| `server_invites` | `server_id` | 可路由 Invite Token |
| `members` | `server_id` | serverId |
| `agents` | `server_id` | serverId |
| `agent_im_routes` | `im_user_id` | 腾讯 IM 状态回调 To_Account |
| `agent_runtime_credentials` | `server_id` | 可路由 Runtime credential |
| `computers` | `server_id` | serverId |
| `computer_setup_codes` | `code_hash` | 一次性安装码摘要 |
| `computer_runtime_credentials` | `server_id` | Computer Runtime credential |
| `computer_agent_observations` | `server_id` | serverId + Computer/Agent launch receipt |
| `tat_instance_bindings` | `binding_hash` | region+TAT instance 全局占用 |
| `channels` | `server_id` | serverId |
| `channel_members` | `server_id` | serverId |
| `message_thread_refs` | `server_id` | serverId + channelId + threadId |
| `message_thread_reads` | `server_id` | serverId + threadId + memberId |
| `tasks` | `server_id` | serverId |
| `reminders` | `server_id` | serverId |
| `reminder_occurrences` | `server_id` | serverId |
| `tencent_operations` | `partition_key` | Queue 消息携带 partitionKey |
| `idempotency_records` | `partition_key` | 请求上下文可推导 |
| `outbox_events` | `partition_key` | Queue 消息携带 partitionKey |

### 4.1 不使用单表

TDSQL 的 Noshard 单表默认集中到第一个 set。账号索引、slug、操作队列等都会持续增长，
不能以“初期数据少”为理由建成单表。

### 4.2 暂无广播表

当前没有需要与所有分表频繁 JOIN 的小型低频配置表。Runtime 种类、错误码等静态
配置放在代码或配置中心。未来确有国家区划、产品字典等小表时，再独立评审广播表。

## 5. 全局访问问题

### 5.1 登录账号

`accounts` 按 accountId 分片，但登录入口只有邮箱/手机号。因此增加：

```text
account_login_identities
id
login_hash shardkey
kind = email | phone | oauth
normalized_login
account_id
state = active | retired
```

流程：

```text
normalize(login) → SHA-256 hex login_hash
→ 点查 account_login_identities
→ 得到 account_id
→ 点查 accounts shardkey=id
```

全局登录名唯一由注册表保证。Account 行中的 email 只是显示快照，不承担唯一性。

### 5.2 我的 Server 列表

`members` 按 serverId 分片，不能在登录后按 accountId 做广播查询。因此增加只读
投影：

```text
account_server_memberships
id
account_id shardkey
server_id
member_id
role/status
server_name/server_slug snapshot
server_revision
```

Member 是权限事实；该投影只服务列表。投影短暂陈旧不会扩大权限，进入 Server 时
仍点查 `members(server_id,member_id)`。

### 5.3 Server slug

`servers` 按 ID 分片，slug 的全局唯一和解析由：

```text
server_slug_registry
id
slug shardkey
server_id
state = reserved | active | retired | purged
```

保证。slug 必须是 ASCII 且创建后不可修改。按 slug 访问先点查 registry，再按
serverId 点查 Server。

### 5.4 TAT 实例占用

Computer 在 Server 分片内，但同一 TAT 实例不能绑定两次。增加：

```text
tat_instance_bindings
id
binding_hash shardkey
tat_region
tat_instance_id
server_id
computer_id
state = reserved | active | retired
```

`binding_hash=SHA-256(tatRegion + 0x00 + tatInstanceId)` 的小写十六进制。注册表负责
全局唯一，Computer 表内唯一索引只负责 Server 内约束。解除纳管和重新认领均以
`binding_hash + server_id` 两分片短事务完成；`retired/purged` 墓碑永久保留。

### 5.5 Agent IM 回调路由

腾讯 IM `State.StateChange` 回调只携带 `To_Account`，没有 server_id。增加：

```text
agent_im_routes
id
im_user_id shardkey
server_id
agent_id
state = active | retired
```

回调先按 im_user_id 点查该 Registry，再按 server_id 更新 Agent 分片。该表不保存
聊天内容或在线历史，`server_id,agent_id` 只建普通索引，避免在 TDSQL 上建立不含
shardkey 的唯一索引。

## 6. 可路由凭证

所有由“只有 Secret、没有路径”的入口都必须自带不可伪造的路由信息：

```text
Refresh Token:
rt1.<accountId>.<sessionId>.<32-byte-random-base64url>

Invite Token:
inv_<serverId>.<inviteId>.<randomSecret>

Agent Runtime Credential:
arc_<serverId>.<agentId>.<version>.<randomSecret>
```

路由前缀是公开定位信息，不承担认证。后台先解析 shardkey，再在目标分片验证完整
Secret 哈希、状态和有效期。不能仅信任 Token 自报的 ID。

## 7. 主键和唯一键

Server 分表统一采用：

```sql
PRIMARY KEY (server_id, id)
UNIQUE KEY (...server_id, business_key...)
) shardkey=server_id;
```

`servers` 特例：

```sql
PRIMARY KEY (id)
) shardkey=id;
```

Account 分表：

```sql
accounts:      PRIMARY KEY(id) shardkey=id
auth_sessions: PRIMARY KEY(account_id,id) shardkey=account_id
```

基础设施表：

```sql
PRIMARY KEY(partition_key,id)
UNIQUE KEY(partition_key,...idempotency fields...)
) shardkey=partition_key;
```

任何新建唯一索引的 migration 都必须通过 CI 检查其首组列中包含 shardkey。TDSQL
不支持外键，所有 `server_id` 复合归属由事务查询和一致性扫描保证。

## 8. 事务边界

### 8.1 单分片主链路

以下均必须保持单分片：

- Server Member/Channel membership；
- Agent/Computer 配置；
- Task 指派和 Outbox；
- Reminder occurrence 和 Outbox；
- Agent lifecycle 与 TencentOperation；
- Server 内幂等记录。

### 8.2 允许的低频分布式事务

仅允许四类管理流程使用 TDSQL 2PC：

1. Account 登录身份生命周期：`account_login_identities + accounts`；
2. Server slug 生命周期：`server_slug_registry + Server Group-Shard`；
3. Computer TAT 绑定、解除纳管与重新认领：`tat_instance_bindings + Computer Group-Shard`；
4. Agent IM 路由生命周期：`agent_im_routes + Agent Group-Shard`。

这些事务必须短、小、无外部网络调用。腾讯云 IM/TAT 调用只能在事务提交后执行。

`account_server_memberships` 是可重建投影，不参加 Member 权威事务，避免成员操作
变成跨分片 2PC。

## 9. Worker 路由

热路径禁止执行：

```sql
SELECT ... FROM outbox_events
WHERE state='pending'
ORDER BY available_at
LIMIT ...
```

因为没有 shardkey，会广播所有 set。

正常流程：

1. 本地事务写 Outbox；
2. 提交后把 `{partitionKey,eventId}` 投递 Redis Stream；
3. Worker 按 partitionKey 点查 Outbox 和 TencentOperation；
4. Redis 只负责唤醒，数据库仍是事实源；
5. 低频恢复扫描允许广播所有 set，查找长期 pending 行并重新入队。

恢复扫描是受监控的运维兜底，不是正常消费路径。

## 10. 查询规则

- Repository 方法的第一个业务参数必须是 shardkey；
- 禁止只按 `id` 查询 Server 子表；
- 禁止在线接口做跨 Server ORDER BY/GROUP BY；
- Admin 全局报表使用 CDC/分析库，不压 OLTP Proxy；
- 允许的广播查询必须显式标注 `scatter_allowed` 并设置超时、行数上限；
- 分页 cursor 必须包含 shardkey 和局部排序键；
- 所有 UPDATE/DELETE 带 shardkey 和 WHERE；
- 不修改 shardkey；资源归属变化通过“新建+终止旧行”完成。

## 11. DDL 和测试门禁

CI 必须检查：

1. 每张业务表显式声明 `shardkey`；
2. 主键和每个唯一索引包含 shardkey；
3. Server Group-Shard 列类型/长度/字符集/排序规则完全一致；
4. INSERT 显式列出 shardkey；
5. 热路径 SQL 的 WHERE 包含 shardkey 等值条件；
6. migration 不创建外键、触发器、存储过程或自建分区；
7. 不依赖窗口函数、无条件 UPDATE/DELETE；
8. 2PC 只出现在上述四个低频 registry 生命周期；
9. Worker 消息包含 partitionKey；
10. 在至少 4 个 set 的测试实例执行路由、同 set JOIN 和故障恢复测试。
