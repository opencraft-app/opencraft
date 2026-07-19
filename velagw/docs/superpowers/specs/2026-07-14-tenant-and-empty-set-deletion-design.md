# 租户删除与 Set 销毁设计

## 背景

LLMGateway 当前支持禁用租户、停止 Set 接入和禁用 Set，但没有完整的物理删除闭环。生产 Fleet 已出现 LLMFleet 运行态数量与控制面 Set 记录数量不一致，测试产生的租户、new-api 用户、MySQL 数据库、Redis DB 和 runtime lease 也无法通过稳定 API 回收。

本设计新增两个独立能力：

1. 删除租户：立即撤销流量访问，清理 LLMGateway 管理的数据，并尽力清理对应 new-api 用户资源。
2. 销毁 Set：默认只接受没有用户绑定的 Set；显式级联模式可先批量撤销整个 Set 的流量路由和本地投影，再从 LLMFleet 移除运行态、清空 Redis DB、删除 MySQL 数据库，最后释放 runtime lease。

Set 销毁绝不隐式级联删除租户。调用方必须先 preview，并显式提交 `cascade_tenants=true`；系统不提供无条件的全 Fleet 清空接口。需要逐用户清理 new-api 资源时仍使用租户删除作业，测试 Set 和整 Set 退役优先使用级联销毁。

## 设计目标

- 提供稳定、幂等、可查询、可重试的管理 API，方便 Codex 和管理控制台执行删除作业。
- 批量租户删除只支持 `user_ids`、`user_id_prefix`、`set_id` 三种明确范围，禁止无条件 `all=true`。
- 删除执行前必须预览，启动时校验预览 ID 和预期数量，避免范围被意外扩大。
- 用户删除开始后先阻断流量，再执行远端和本地清理。
- Redis DB 和 MySQL 数据库清理成功前绝不释放 runtime lease。
- 不修改 new-api 源码，不让 set-manager 直接读取 shard Secret 或创建运行资源。
- 保留极薄 tombstone 和作业记录用于幂等与故障恢复，不建设审计系统。

## 非目标

- 不实现 Set 间用户自动迁移。
- 不修改 old ai-gateway 数据；旧后端租户只清理 LLMGateway 本地状态。
- 不提供无条件全环境清空接口。
- 不在普通 Set 注销中自动删除仍绑定的用户，也不在级联模式中逐用户调用 new-api。

## 方案选择

### 方案 A：同步 DELETE API

实现最少，但远端 new-api 调用和大批量删除容易超时，调用中断后难以判断完成程度，不适合数万租户。

### 方案 B：MySQL 持久化异步作业（采用）

预览、启动、进度、失败明细和重试均落 LLMGateway MySQL。worker 分批推进租户删除，set-manager 推进 Set 注销。进程重启后可以继续，适合 Codex 编排和管理台展示。

### 方案 C：一键 Fleet Reset

全量测试清理最快，但误操作半径最大，也无法复用为日常租户删除和单 Set 回收能力。本期不提供。采用方案 B 的单 Set 级联扩展，由调用方逐个提交并监控 Set 作业。

## 租户删除作业

### 选择器与预览

一次请求必须且只能提供一种选择器：

```json
{"user_ids":["user-a","user-b"]}
{"user_id_prefix":"load-20260714-"}
{"set_id":"set-auto-000071"}
```

`user_ids` 有固定数量上限，超出时拆成多个作业。`user_id_prefix` 必须满足最小长度，`set_id` 必须对应已纳管 Set。所有模式都先调用预览 API。

预览不是对动态查询只做一次 `COUNT`。它使用 MySQL 当前时间冻结数据水位 `snapshot_at`，再创建 `materializing` 作业，用专用窄查询把 `created_at <= snapshot_at` 的匹配对象写入 `llmgateway_tenant_deletion_targets(job_id, external_user_id, snapshot_set_id, snapshot_tenant_updated_at, status, attempts, last_error, updated_at)`。物化使用持久化主键 cursor 分批提交，不维持覆盖全部目标的长事务；完成后作业才进入 `previewed`，返回固定目标集的 `matched_count` 和 `target_digest`。digest 固定为按 external user ID 字节序排序、逐项追加长度前缀后的 SHA-256。启动只引用该 preview job，不重新执行选择器；必须提交 `expected_count`、`target_digest` 和 `idempotency_key`，任一不匹配都返回冲突。`snapshot_at` 是数据边界，`expires_at` 是 preview 的操作有效期，二者含义独立。

目标表以 `(job_id, external_user_id)` 为主键，并增加 `(job_id, status, external_user_id)` 消费/失败索引。启动先进入 `claiming`，maintenance worker 持有全局 claim-materializer lease，按 1000 至 5000 行分批写入 `llmgateway_tenant_deletion_claims(external_user_id, job_id)`，claims 另有 `(job_id, external_user_id)` 回收索引；主键冲突表示目标已被另一运行作业占用。发生冲突时作业进入 conflict，并按 job ID 分批释放本作业已经写入的 claim，不能留下半启动作业。claiming/conflict 回收阶段自身使用可续期 lease，maintenance worker 崩溃后可接管。全部 claim 完成后才 CAS 为 queued。`set_id` 选择器还必须校验每个目标仍属于 `snapshot_set_id`，任何用户已迁移都使启动冲突并要求重新预览。preview 可以重叠，running 作业不能重叠。作业 claim 同时阻止目标用户迁移、重新绑定和其他从属写入。过期 preview 由 cleanup job 分批回收 target，不影响租户数据。

目标物化不复用租户列表的多表 JOIN、key count 或 `updated_at` 游标：

- `user_ids` 使用主键点查，单作业最多 1000 个；
- `user_id_prefix` 把转义后的前缀转换为主键范围；
- `set_id` 使用新增索引 `(set_id, external_user_id)`；
- target 消费固定按 `(job_id, external_user_id)` 前进，不受 Tenant 状态更新时间影响。

物化和删除由独立的 `llmgateway-worker-maintenance` 角色执行，不占用 core、BYOK 或 observer worker。maintenance worker 没有 Kubernetes/Fleet 权限，使用 MySQL lease 横向扩展，并对每个 Set 设置有界远端并发。

### 状态机

```text
materializing -> previewed -> claiming -> queued -> running -> succeeded
                         |
                         +-> paused  -> queued（显式恢复）
                         +-> partial -> queued（显式重试失败项）
                         +-> error   -> queued（显式重试）
```

作业保存稳定 target cursor、水位、成功数、失败数、最近错误、lease owner 和 lease 到期时间。每个 target 自身保存状态；作业终态并经过保留期后，成功 target 可以压缩，只长期保留作业摘要和失败项。连续出现同 Set、同错误类别的远端故障达到阈值时自动进入 `paused`，避免一次上游故障制造数十万条重复失败。

### 单租户删除顺序

1. 在数据库事务中把 Tenant 从 `active/disabled` CAS 为 `deleting`，绑定当前 job 和 target；阻断新的控制面写入。
2. 删除该用户所有 Redis traffic route snapshot，确保外部 Key 立即失效。
3. 若租户属于 new backend，读取 UserBinding、APIKeyBinding 和 UserLLMSettings：
   - 失效 active subscription；
   - 使用用户登录态反复读取 token 第一页并调用 batch delete，直到 count 为 0；至少必须显式删除 LLMGateway 已知的 `upstream_key_id` 和 BYOK token，不能只依赖 new-api 的 cache invalidation；
   - 删除已知 BYOK channel；
   - 调用 new-api `POST /api/user/manage` 的 `delete` 动作，使用户失效并让 new-api 清理 token cache；
   - 只有管理员查询明确确认用户不存在，才把“远端不存在”视为幂等成功；登录失败、2FA、密码漂移和网络错误不能映射成不存在。
4. 步骤 4 至 7 是同一个按 target 提交的最终数据库事务：删除 binding、assignment、API key、BYOK 设置与任务、观测与任务、订阅 overlay 等用户从属记录；订阅幂等表没有 `user_id`，不得猜测归属后删除。
5. 在该事务中删除用户 BYOK group ratio intent，并把对应 Set 的倍率 apply state 推进到新版本，由现有倍率 worker 收敛远端配置。
6. 在该事务中将 Tenant CAS 为 `deleted`，保留 `user_id/status/deletion_job_id/updated_at` 最小 tombstone，防止迟到任务或重复请求重新创建用户。
7. 仅当事务实际删除了一条 binding 时递减对应 Set 的观测用户数，同时把 target 标为成功、推进计数和 cursor；崩溃重试不得重复递减。后台精确统计最终校准。租户列表和运营总数默认排除 deleted tombstone，只有显式状态筛选时才展示。

删除开始后远端失败不恢复用户访问，只记录失败并等待重试。old backend 租户不调用旧系统删除 API。

### 并发与幂等

- 同一用户同一时间只能属于一个运行中的删除作业，由 `tenant_deletion_claims` 主键保证。
- worker 使用 MySQL lease 领取作业，每次只处理有限 batch，lease 通过心跳续期。
- 每一步按“已不存在即成功”实现，可在任意进程崩溃点安全重试。
- `SaveTenant` 不允许普通业务写把 `deleting/deleted` 恢复为 active；恢复必须走独立管理动作。
- binding、assignment、API key、BYOK 设置/任务、观测/任务、订阅 overlay 等用户从属写入必须在数据库写事务中锁定 Tenant，并拒绝 `deleting/deleted`，不能只做 Service 层前置检查。BYOK、观测和订阅任务提交结果前再次检查状态。

## Set 销毁作业

### 创建条件

Set 销毁必须先预览。preview 无副作用，返回摘要和以下权威计数：

- 非 deleted Tenant；
- `llmgateway_user_bindings` 为 0；
- `llmgateway_api_key_bindings` 为 0；
- assignment、BYOK/观测任务与投影、subscription overlay、group ratio user intent 等用户从属记录为 0；
- 没有非终态 tenant deletion target 指向该 Set；
- 没有有效的 Set operation lease；
- 存在完整 runtime lease，可确定 shard、database name 和 Redis DB。

启动请求提交 `set_id`、`expected_digest` 和 `idempotency_key`。普通模式再次执行权威空集检查；全部通过后才递增 `lifecycle_generation`、把 Set 切为 `draining` 并创建 pending 作业。级联模式必须额外提交 `cascade_tenants=true`，并且不能存在非终态租户删除目标或有效 Set operation lease。控制面在同一事务中把 Set 切为 `draining`、把其租户置为 `deleting`，作业进入 `purging_tenants`。maintenance worker 批量删除 Redis 路由和本地租户投影，完成后作业才进入 pending。

级联模式不逐用户调用 new-api。new-api 只作为即将整体销毁的下发目标；远端用户、token、channel 最终随专属 MySQL database 和 Redis DB 一次性回收。没有 runtime lease 的孤儿 Set 只有在已停用且显式提交 `allow_orphan=true` 时才允许清理本地投影；它不会猜测或扫描未知存储。多份 runtime lease 一律拒绝。

所有新归属路径必须在提交 binding 时锁定并确认 Set 仍为 `active`；`TryReserveSetUserSlot` 也只允许 active、setup 且 admission passed 的 Set。这样已经选中但尚未提交的并发请求不能越过 draining 门禁。

`TryAcquireSetOperationLease` 必须在同一事务锁定 Set，只允许 active、无 decommission tombstone 的 Set，并把当前 `lifecycle_generation` 写入 lease。BYOK、订阅、倍率、观测和渠道任务在远端调用前、结果提交前都验证 Set 仍 active 且 generation 未变化。Set 进入 draining 后禁止新 operation lease；注销作业等待所有旧 generation lease 释放或过期后，才允许进入 runtime removal。

set-manager 不能使用“GET pending 后直接 patch”。它必须调用原子 claim API；control 在同一事务锁定 Set 和作业、确认没有有效 operation lease、执行第三次权威空集检查，并把 `pending -> removing_runtime`，返回不可变 cleanup payload、`claim_token/job_version/lease_until`。只有 claim 成功后 set-manager 才能 patch LLMFleet。claim 需要心跳续期，进程崩溃后可由下一次 set-manager 在 lease 过期后重领并继续相同 cleanup。

cancel 必须带 `expected_version + idempotency_key`，与 claim 锁同一作业/Set 行，只允许 claim 前执行；cancel 成功只恢复原业务状态，`lifecycle_generation` 永不回退。claim 成功后 cancel 必然返回冲突。若第三次空检异常发现记录，claim 失败、作业进入 error 且 Set 保持 draining，调用方可修复后重试，或在 runtime 尚未移除时显式 cancel。

### 状态机

```text
purging_tenants（仅级联模式，由 maintenance worker 执行）
  -> pending
  -> removing_runtime
  -> cleaning_data
  -> finalizing
  -> succeeded
       \
        -> error -> pending（显式重试，attempt + 1）
```

### LLMFleet 与 KRO 回收

`LLMFleet.spec` 新增最大长度为 1 的 `cleanups` 集合。每项包含不可变 `cleanup_id`、`set_id`、`attempt`、runtime lease fingerprint、短期单用途 cleanup capability、shard、database、Redis DB 及该 shard 的 `redisDBStart/redisDBLimit`。该 capability 对具有 LLMFleet 读权限的主体可见，因此不授予通用 API 权限，只能在 TTL 内对完全匹配的 cleanup/attempt/lease payload 重复授权；attempt 变化或 finalization 后失效。Redis DB 范围成为 LLMFleet shard 的显式不可变配置，不再只存在于容量 worker 环境变量。set-manager 每次只推进一个 Set 注销作业，并使用 `metadata.resourceVersion` 同时完成：

1. 从 `spec.sets` 移除目标 Set，使 KRO prune admin/traffic Service 和 Deployment。
2. 向 `spec.cleanups` 写入 Set、shard、database、Redis DB 和 attempt，不写入任何密钥。

KRO 为 cleanup 集合生成一次性 Job，Job 名包含 `cleanup_id` 和 `attempt`，运行同一镜像中的 `llmgateway-runtime-cleaner`。Job 设置 `restartPolicy: Never`、有界 `backoffLimit` 和 `activeDeadlineSeconds`，通过 shard Secret 注入凭据，不挂载 service-account token，也不持有 control token。cleaner 必须：

1. 使用一次性 cleanup ticket 调 control 授权接口；control 校验当前 cleanup/attempt/lease fingerprint/数据库/Redis DB/范围完全一致。ticket 只授权这一项清理，不是通用 control token，attempt 变化或作业终态后立即失效。
2. 校验 database name 与 Redis DB 和 cleanup 中冻结的 runtime lease fingerprint 一致；database name 必须符合 `newapi_[a-z0-9_]+` 且不是系统库，Redis DB 必须位于 shard 的显式允许范围。
3. 等待目标数据库连接连续多次为 0；超时非零退出。
4. 同步清空专属 Redis DB，验证 `DBSIZE=0`；失败非零退出。
5. 再次校验 cleanup ticket 仍有效，然后执行参数安全的 `DROP DATABASE IF EXISTS`；失败非零退出。

cleanup Job 的 `cleanup_id/attempt/job_uid/active/succeeded/failed` 投影到 LLMFleet status。Job 不设置成功 `readyWhen`，避免失败清理拖低整个 Fleet Ready。set-manager 只读取 LLMFleet，无需读取 Secret 或直接创建 Job。

cleanup Job 不参与整个 Fleet 的 Ready 条件，避免单个清理失败阻塞新增 Set。运行超时只保持 `cleaning_data`，不允许创建并发 attempt；只有 Job 明确进入 Failed 且 Pod 已终止后才能 retry。retry 必须提交 `expected_attempt` 和 `idempotency_key`，数据库 CAS 递增 attempt，KRO 才创建下一 Job。

control 只接受当前 `cleanup_id + attempt + lease fingerprint + job UID + claim_token` 的状态证据。迟到 attempt、过期 claim、状态缺失、Job 仍 active 或 fingerprint 不匹配都拒绝收尾并保留 lease。一个 cleanup collection 同时最多存在一个 Job，旧 Job 终态并被 KRO prune 后才进入下一 attempt。

### 最终释放

只有 cleanup Job 成功后，control 才在一个收尾事务中：

1. 将对应 provision request 标为 `cancelled`；
2. 删除 runtime lease；
3. 删除/失效 Set operation lease、group ratio、channel sync、bundle sync、Set Plan 等运行投影；历史 release run 保留；
4. 将旧 reconcile fact 标为 retired，并保留 decommission tombstone，拒绝迟到 fact；
5. 清除 bundle 的 source Set 运行引用，revision 内容不变；
6. 删除 Set registry 行；
7. 将 decommission 作业标为 `succeeded` 并保留 tombstone。

任何清理失败都保留 runtime lease，数据库名和 Redis DB 不能被重新分配。

成功握手顺序固定为：KRO 保留成功 Job 和 status 证据；set-manager 提交当前 Job 证据；control 原子执行上述 finalization，并把作业置为 `cleanup_ack_pending` 后返回 ack；set-manager 收到 ack 后才从 `LLMFleet.spec.cleanups` 移除该项，KRO 随后 prune Job，再由 control 标记 `succeeded`。内部非终态查询包含 `cleanup_ack_pending`；即使 finalization 的响应在网络中丢失，新的 set-manager 也会重新取得同一成功证据、收到幂等 ack 并移除 cleanup item。不能提前丢失成功证据，也不能让已完成项永久占据长度为 1 的集合。

## API

### 租户删除

```text
POST /api/admin/tenant-deletions/preview
POST /api/admin/tenant-deletions/{job_id}/start
GET  /api/admin/tenant-deletions
GET  /api/admin/tenant-deletions/{job_id}
GET  /api/admin/tenant-deletions/{job_id}/failures
POST /api/admin/tenant-deletions/{job_id}/pause
POST /api/admin/tenant-deletions/{job_id}/resume
POST /api/admin/tenant-deletions/{job_id}/retry
POST /api/admin/tenant-deletions/{job_id}/abandon
```

预览先返回 `materializing`，物化完成后的响应包含 `job_id`、规范化选择器、`matched_count`、`target_digest` 和强制生效的 `expires_at`。start 请求必须包含 `expected_count`、`target_digest` 和 `idempotency_key`。过期 preview 返回 409。pause/resume/retry/abandon 都要求 `expected_version` 和 `idempotency_key`，使用 CAS 防止重复操作。list、detail 和 failures 都使用稳定 cursor pagination，并返回结构化 `error_type/message/retryable`。abandon 只允许 paused/partial/error 作业：先确认 Redis traffic route 已删除，再对剩余目标执行本地安全失效和 tombstone 收尾、保留远端清理错误、释放 claim；不能把用户恢复为 active。

### Set 销毁

```text
POST /api/admin/set-decommissions/preview
POST /api/admin/set-decommissions
GET  /api/admin/set-decommissions
GET  /api/admin/set-decommissions/{job_id}
POST /api/admin/set-decommissions/{job_id}/cancel
POST /api/admin/set-decommissions/{job_id}/retry
```

preview 请求只接受 `set_id`，返回 `digest` 和各类占用计数。创建请求接受 `set_id`、`expected_digest`、`idempotency_key`，以及可选的 `cascade_tenants/allow_orphan`。摘要变化、并发操作、运行记录异常或缺少显式级联确认均返回 409。cancel 只允许普通 pending 作业；级联一旦进入 `purging_tenants` 就不可取消，以免恢复到只清掉一半路由的状态。

### set-manager 内部接口

```text
GET  /api/internal/set-manager/set-decommissions?phase=non_terminal&limit=1
POST /api/internal/set-manager/set-decommissions/{job_id}/claim
POST /api/internal/set-manager/set-decommissions/{job_id}/renew
POST /api/internal/set-manager/set-decommissions/{job_id}/status
POST /api/internal/runtime-cleanups/authorize
```

set-manager 不再复用 cluster admin token，也不再 `envFrom` 整份 control runtime Secret。它使用独立 Secret 中的 scoped token，只能调用 set-manager 所需的 provision/fact/decommission 内部路径，不能访问 `/api/admin/*`、LLMGateway SQL/Redis DSN 或 new-api 凭据。它必须列出所有非终态作业并重新领取 lease 已过期的 removing/cleaning/finalizing 作业，保证 patch 后进程重启可以继续观察同一个 Job。状态更新包含阶段、attempt、lease fingerprint、claim token 和 Job 证据，不接受任意资源字段覆盖。worker 没有 LLMFleet patch 权限。cleaner 没有通用 control token，只携带短期、单 cleanup ticket。

## Codex 作业流程

```text
预览租户范围
-> 人类或调用方核对 matched_count
-> 启动租户删除
-> 轮询至 succeeded/partial
-> 对 partial 显式重试
-> 预览目标 Set 已为空
-> 对空 Set 提交普通注销，或对整 Set 提交显式级联销毁
-> 轮询 cleanup 和最终 lease 释放
```

全量测试重置按 Set 逐个执行，不存在单次无范围清空请求。容量控制器可以在旧 Set 回收期间创建替代 Set；新 Set 只能在完整 admission 通过后接收用户。

## 管理界面

- 租户详情增加“删除用户”，先展示预览结果和受影响的 Key/BYOK/订阅摘要，再允许确认。
- 租户列表支持对当前明确搜索结果创建批量删除预览，不提供“选择全部环境”。
- Set 详情增加“销毁集群”；预览为空时显示普通注销，非空时显示占用数量和“强制销毁”，两者都要求输入完整 Set ID。
- 后台任务页新增“删除作业”分区，展示进度、失败数、最老等待时间和重试入口。

## 测试

### 单元与存储测试

- 选择器互斥、前缀最小长度、snapshot 数据边界、preview 过期和 expected count/digest 校验。
- target 稳定物化、分批 claim 冲突回收、同用户并发作业互斥、lease 过期接管、cursor 不重复推进。
- 用户先失效路由，再调用远端；远端不存在和重复删除幂等。
- 本地从属记录事务清理，Tenant tombstone 保留。
- 非空 Set 默认拒绝注销；只有显式级联模式可以继续。并发删除任务、活跃操作租约和多 runtime lease 始终阻止销毁。
- cleanup 失败不释放 lease；成功后 provision、lease、fact、registry 原子收尾。
- draining 后新 operation lease 必须失败；第三次空检和并发 acquire 只能有一方成功。
- cancel 和 set-manager claim 锁同一版本，只能有一方成功；claim 后的 stale cancel 不能恢复 active。
- 旧 cleanup attempt、错误 Job UID、过期 claim token 和错误 lease fingerprint 不能触发 finalization。
- late fact 不得重新纳管已注销 Set。

### HTTP 测试

- admin auth、预览/start/get/list/retry。
- 禁止空选择器、多个选择器、`all=true`、错误 expected count。
- Set 注销错误原因结构化返回。

### set-manager 与清理器测试

- resourceVersion 冲突安全重试。
- Fleet patch 同时移除 Set、添加 cleanup。
- cleanup status 成功、失败、attempt 重试和成功证据 ack 后移除。
- cleaner 等待连接、Redis 清理失败、DROP DATABASE 幂等。

### E2E

- 创建测试租户和 Key，删除后 traffic 立即拒绝，new-api 用户失效，本地记录只剩 tombstone。
- 删除最后一个用户后注销 Set，验证 KRO 资源消失、数据库不存在、Redis DB 为空、runtime lease 释放。
- cleanup 人为失败后 lease 保留，修复后 retry 完成。
- 删除期间容量控制可创建替代 Set，替代 Set 未通过 admission 前不接收用户。

## 发布安全

- 首次生产发布只开放 API 和 UI，不自动清理任何现有数据。
- 云上删除演练必须使用新建测试用户和新建测试 Set。
- 对北京存量数据执行批量删除前，仍需人类明确确认预览数量。
