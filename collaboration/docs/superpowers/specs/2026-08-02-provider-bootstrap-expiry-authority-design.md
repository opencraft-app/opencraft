# Provider Bootstrap 过期时间单一权威修复设计

## 背景与根因

真实 macOS Computer 安装已完成 0.1.2 下载和 SHA-256 校验，并成功 claim 长期
Computer credential。随后 `POST /v1/bootstrap/provider-registration` 稳定返回 500：
`Computer 接入结果结构无效`。

腾讯 TAT Adapter 使用 `time.Now().UTC().Add(time.Hour)` 生成注册码过期时间，保留纳秒。
应用把该时间写入 AEAD 加密注册材料，同时投影到 TDSQL
`tencent_operations.deadline_at datetime(3)`。TDSQL 只保留毫秒；读回后旧实现要求两个时间
`time.Equal`，因此合法结果被误判为损坏。

## 设计决定

采用单一权威来源：

- AEAD 加密材料中的 `expiresAt` 是注册码业务有效期的唯一权威；
- `tencent_operations.deadline_at` 是 Worker 调度、数据库索引和过期清理使用的投影；
- recover 不比较二者是否精确相等，也不引入毫秒容差；
- recover 解密后必须继续校验 AEAD、Operation/Server/Computer/credential version 关联数据、
  protocol、region、注册码 ID/value、tags 和 `payload.expiresAt > now`；
- 对 succeeded Operation，数据库 deadline 完全不参与响应有效性判定；必须先解密并只以
  payload expiry 判定。即使 `deadline_at <= now < payload.expiresAt`，材料仍应返回 ready；
- payload 已过期且 Computer 仍满足 provisioning/credential fence 时，原 Operation 以 CAS
  原子清空过期结果并重新进入 pending，由 Worker 生成新注册码；这不是删除行，也不创建第二条
  并发 Operation。

不修改 TDSQL Schema，不把 `datetime(3)` 升级为 `datetime(6)`，不人工改库或删除旧资源。
仅当合法 AEAD payload 已过期时，受 fence 保护的状态机才修改原 Operation 并创建新注册码。

## 实现范围

### 应用服务

`internal/app/computerbootstrap.Service.recover`：

1. 要求 succeeded Operation 存在非空加密结果；
2. 解码并 AEAD 解密；
3. 严格解码 payload；
4. 校验协议、地域、注册码、tags 和 payload expiry；
5. payload 未过期时返回 ready；
6. 不再要求 `payload.ExpiresAt.Equal(operation.ResultExpiresAt)`。

`recover` 使用内部 typed expired outcome；它只能在 AEAD/AAD、严格 JSON、protocol、region、
非空 ID/value、精确 tag 全部通过且 expiry 非零之后产生。零时间或任何结构损坏均返回
`internal_error`，不得触发续期。

`Service.GetOrCreate` 对 typed expired outcome 调用 Repository `RenewExpired`：

1. 命令绑定 Operation/Server/Computer/credential version，并携带期望的旧密文；
2. Repository 在同一 Server shard 事务内按 Computer → credential → Operation 固定顺序锁定三行；
   TDSQL/MySQL 使用 `SELECT ... FOR UPDATE`，SQLite 使用等价的写事务/条件更新；
3. 锁内重新验证 Computer 仍是 provisioning、managed、无 instance，claim/credential version
   匹配，credential active、未撤销且未过期；
4. 仅当 Operation 仍为 succeeded 且持久化密文与期望值相同时，CAS 清空 result/completed/error、
   attempts 归零、deadline 更新为新的 material TTL，并切回 pending；
5. `fence invalid` 返回 `ErrNotEligible`；`CAS lost` 不是资格错误，Repository 必须重读当前
   Operation 返回调用方。调用方复用正常状态机：pending/running/retry_wait 返回对应 pending，
   failed 返回 `provider_registration_failed`，succeeded 最多再 recover 一次；控制流有界，
   不能递归自旋；
6. Computer 激活或 credential 撤销的 UPDATE 会与同一行锁线性化：若先发生，续期在锁内看到
   fence 失效；若续期先完成，后续生命周期变更发生在 pending 之后。不存在“验证通过后再被
   并发撤销、仍无条件续期”的窗口。

为保持持久投影可运维，`ProcessOne` 仍将 payload expiry 写入 `deadline_at`，但不改变
payload 精度，也不把投影读取值带回业务内容。数据库 deadline 只影响 pending/running Worker
领取和清理，不影响 succeeded payload 的 ready/expired 判断。

v1 payload 的 tag 不变量是且仅有一项：
`chatserver-computer-id=<operation.ComputerID>`。空、错误、重复或额外 tag 均视为损坏。
空密文、AEAD/AAD 失败、严格 JSON 失败、错误 protocol/region、空注册码继续返回
`internal_error`；仅合法 payload 的业务 expiry 已过期才进入续期。

### 客户端与协议

不改变 API、OpenAPI、Computer 0.1.2、安装器、本地状态格式或错误码。客户端继续以同一
Computer credential 幂等请求。当前 `credential_claimed` 状态可以原地恢复。

### Provider material 与 TAT 注册对账的桥接

真实恢复发现，`computer-bootstrap` Operation 只负责安全生成注册码；通用 TAT Worker 只消费
`service=tat/kind=tat.computer.registration.reconcile`。二者若不显式桥接，客户端可以完成
本地 TAT 注册，但后台 Computer 会永久停在 `provisioning/unknown`。

因此，服务在返回一份合法且未过期的 ready material 前，必须先在同一 Server shard 内幂等
确保一条 TAT 注册对账 Operation：

- 幂等身份由 bootstrap Operation ID 与加密 material 的 SHA-256 共同构成；不保存或复制
  注册码明文；
- 同一份 material 的重复 GET 不增加 Computer revision、不创建第二条 Operation；
- 新 material 使用新的 fingerprint 和新 Operation，旧 material 的失败/过期记录保留审计；
- 创建时重新验证 Computer 仍为 provisioning/managed/未绑定、claim 与 credential version
  匹配，credential active、未撤销且未过期；
- 在一个事务中写入 `registration_expires_at`、提升 Computer revision、创建
  `tat.computer.registration.reconcile` 及对应 outbox；通用 TAT Worker 随后按稳定 tag 发现
  唯一 `rins-*` 并把 Computer 收敛到 active/online；
- bridge 失败时不得把注册码返回客户端，避免再次形成“端侧 complete、平台未调度”的半状态。

这不合并两个 Worker，也不让通用 TAT Worker读取 bootstrap 密文。二者继续保持独立 service，
只通过一条非敏感、幂等的 reconcile Operation 连接。

## 测试

按 TDD 增加以下应用服务和 Repository 测试：

1. succeeded Operation 的数据库 deadline 被截断到毫秒，而加密 payload 保留纳秒时，
   recover 必须成功并返回原注册码；旧代码应稳定失败为 `internal_error`。
2. `dbDeadline <= now < payloadExpiry` 仍返回 ready，证明旧的 deadline 短路已删除。
3. payload expiry 已过期时，同一 Operation 只被一个并发调用 CAS 回到 pending；Worker 生成新
   材料后同一 credential 可恢复 ready，且不产生第二条 Operation/重复并发注册码。
4. 续期时 Computer/credential fence 任一失效都会拒绝。
5. 新增 AEAD/AAD、严格 JSON、protocol、region、空 ID/value、零/过期 expiry，以及空、错误、
   重复、额外 tag 测试；空密文稳定为 `internal_error`。
6. AAD 分别篡改 Operation、Server、Computer、credential version；所有密文/结构/tag 损坏输入
   都断言不调用 `RenewExpired`，HTTP 请求路径也绝不直接调用 Registrar。
7. Repository 并发测试覆盖续期与 Computer 激活、credential 撤销和双续期竞争；fence 先失效
   时 Operation 绝不回到 pending，CAS loser 必须重读并观察 winner 的当前状态。
8. CAS loser 重读分别覆盖 pending、running、retry_wait、failed、succeeded；前三者返回 pending，
   failed 返回稳定业务错误，succeeded 最多 recover 一次，不落入 internal_error 或自旋。
9. ready material 在返回前恰好确保一个 TAT reconcile Operation；覆盖同 material 重放、新
   material 续期、Computer active/已绑定、credential revoked/expired，以及通用 Worker 可领取。

最终执行相关包测试、全仓测试、race、vet、生成一致性和凭证扫描。

## 发布与真实恢复

只构建并发布新的 Chatserver Linux/AMD64 后台镜像，保留 Computer release 0.1.2、数据库、
Service 和三副本 Recreate 拓扑。

发布后先用本机现有 0600 `computer.credential` 幂等请求 Provider bootstrap：若现有材料仍
有效，预期直接从 500 变为 200 ready；若已经过期，预期 202 pending 后由 Worker 续期并变为
200 ready。随后用现有安装状态恢复剩余的 provider registration、TAT 安装和用户级
LaunchAgent handoff；不得打印 credential、注册码或短码。

若发布失败，回滚整个 Deployment 到当前 digest
`sha256:c8f75974cd119870916a41a7caadbb54b88e966635b1bf50f30b578c04a155d7` 和现有
0.1.2 catalog/参数组合。
