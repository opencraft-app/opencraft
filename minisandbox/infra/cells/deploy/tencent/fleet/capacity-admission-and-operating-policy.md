# Rivet FDB/COS Cell 容量、限流与运营策略

状态：**Qualification / 尚未开放生产 placement**
适用布局：北京 `RivetCell`，每 Cell 独占一个 FoundationDB 集群和 COS policy domain
最后核对：2026-08-17

> 历史容量研究快照：本文保留 2026-08-17 当时的限制、未关闭项和压测结果，不能再作为
> 当前 traffic-admission 决策。此后已经落地的 durable placement CAS、serverful Host 硬容量、
> bin-pack、自动休眠、计算/FDB 扩缩容和 clean-room GitOps 会使本文若干“当前缺口”失效。
> 当前唯一权威的开放结论和剩余门禁见
> [`scalable-operable-qualification.md`](./scalable-operable-qualification.md)；新的容量数字必须由
> release-bound receipt 更新，不能直接改写这份历史样本。

## 1. 先定义容量口径

这个系统不能用一个“最多多少 Actor”描述容量。至少要同时验收以下三个维度：

| 维度 | 测量对象 | 不能混淆的地方 |
|---|---|---|
| 活跃并发 | 同时执行请求、打开 SQLite、占用 isolate/VFS binding 的 Actor | Actor 总数不等于请求并发；`RIVET_WORKERD_MAX_IN_FLIGHT=16` 也不等于只能有 16 个活跃 Actor |
| Actor 基数 | 全活跃、全冷以及冷热混合时，每 Cell 的 Actor/数据库总数 | 4096 个 VFS binding 是单进程当前硬闸门，不是已证明的 Cell 数据库上限 |
| 恢复风暴 | Runner/workerd/AZ 丢失后同时重建 owner、isolate 和冷页的 Actor 数 | 稳态 QPS 通过不能外推恢复风暴通过；COS、FDB、Gasoline 和 runtime 会同时受压 |

所有容量值都按 **单 Cell** 记录。平台总容量通过增加独立 Cell 横向扩展；不能把多个
Cell 共享一个 FDB 集群后的逻辑分片数直接相加，宣称物理吞吐或故障域也线性增加。

## 2. 当前已经生效的硬限制

| 切面 | 当前值 | 实际语义 | 当前判断 |
|---|---:|---|---|
| host → workerd 执行并发 | `16` | `RIVET_WORKERD_MAX_IN_FLIGHT` 的进程内 semaphore；请求在发送给 workerd **之前** 取 permit | 已生效；北京三源总并发 48 回归通过，但不是最终 SLO |
| host → workerd 等待队列 | `64` 个、`15s` | `RIVET_WORKERD_MAX_QUEUED=64`、`RIVET_WORKERD_QUEUE_TIMEOUT_MS=15000`；满或超时在发送给 workerd 前返回 `503 + Retry-After` | 已实现并通过 queue-full/timeout 单测；北京恢复风暴收据待跑 |
| 空闲 Actor 自动休眠 | `30s` | `RIVET_WORKERD_IDLE_SLEEP_MS=30000`；每次请求完成后重置可取消计时器，`0` 仅用于显式关闭 | 已纳入 production/e2e-fast profile；生产沉降时延仍需真实流量校准 |
| host → workerd 连接复用 | 关闭 | 每次 loopback 请求使用新连接，避免 workerd/reqwest keep-alive 生命周期不一致导致模糊 POST reset | 已生效；不能用盲重试替代，因为 SQL mutation 可能已经提交 |
| 单 workerd VFS bindings | `4096` | `RIVET_DEPOT_MAX_BINDINGS`；限制同时绑定的 Actor 数据库 | 已生效；达到后必须拒绝新 binding，不能驱逐一个仍在服务的数据库 |
| 单 workerd VFS cache 总预算 | `4 GiB` | `RIVET_DEPOT_MAX_VFS_CACHE_BYTES=4294967296`；进程级 reservation cap | 已生效；不是实际 RSS 上限 |
| 单数据库 VFS page cache | `256` 页 | `RIVET_DEPOT_CACHE_CAPACITY_PAGES`；当前 4 KiB 页约 1 MiB | 已生效 |
| 单 Actor SQLite heap | `16 MiB` | `RIVET_WORKERD_SQLITE_MAX_MEMORY_BYTES` | 已生效；V8 isolate heap 另计 |
| workerd cgroup | `MemoryMax=12G`, `TasksMax=4096` | systemd 最终保护线 | 已生效；触发 OOM 不是可接受的正常背压 |
| workerd-host cgroup | `MemoryMax=1G`, `TasksMax=1024` | systemd 最终保护线 | 已生效 |
| Actor create burst | 默认 `500` | Rivet `pegboard_actor_create` 按 namespace 的进程内 leaky bucket 容量 | 已生效但不是分布式全局限流 |
| Actor create refill | 默认每 `10 ms` 1 个，即约 `100/s` | 每 Engine 进程、每 namespace 的本地 limiter | 多 Engine 时总速率会放大；不能当租户级精确配额 |
| Envoy durable command reconciliation | 每个已连接 Envoy 每 `10s` 扫自己的一个 FDB page，`512` 条/page，按 `envoy_key` 确定性 jitter | ActorCommandKey 是正确性来源；pub/sub 只负责低延迟；cursor 永不越过该 Envoy 的 prefix | 已实现定向分页，不做 namespace/global scan；空 backlog 成本约 `0.1 read txn/s/connected Envoy`，大规模预算仍须压测 |
| serverful pool Actor slot | **未设置硬上限** | `max_concurrent_actors` 只在 serverless pool 分支被原子检查；当前 workerd runner 是 serverful | 生产阻断项：调度 admission 不能只依赖 4096 binding 失败 |
| 单 SQLite commit | 最多 `320` 个 dirty pages | Depot `MAX_COMMIT_DIRTY_PAGES`；按 4 KiB 页约 1.25 MiB raw dirty data，另有编码/索引开销 | 当前硬产品限制；未达到任意大事务标准 |
| 单分支 FDB 瞬时写债 | 目标 `10 MiB`、硬 admission `12 MiB` | 只计 commit/VTX/delta/PIDX/page-history 等可回收权威行；到 `5 MiB` 提前唤醒 compaction，`2 MiB` 余量容纳一个最大合法提交及元数据 | 这是瞬时背压，不是 SQLite 容量 quota；超限返回 retryable `write_backpressure` |
| 单数据库逻辑容量 | 无产品固定 byte quota | 已发布不可变 shard 沉降 COS；FDB 只保留有界写债、索引和精确 cold ref。SQLite `u32` page number 仍给出约 `16 TiB` 格式边界 | 产品契约名为 **Bottomless**；不是物理无限，也不豁免 Cell admission/SLO |
| fork 深度 | `16` | `MAX_FORK_DEPTH` | 已生效 |
| bucket branch 深度 | `16` | `MAX_BUCKET_DEPTH` | 已生效 |
| 每 bucket restore points | `1024` | `MAX_RESTORE_POINTS_PER_BUCKET` | 已生效 |
| 单 shard 热版本 | `32` | `MAX_SHARD_VERSIONS_PER_SHARD` | 已生效，防止 eviction lag 无限放大 |
| compaction FDB 批次 | `500` keys / `2 MiB` values | 每个 install/reclaim activity 的有界预算；reclaim 特例最多 `1024` keys | 已生效；backlog 必须通过重复的 branch-local job 排空 |
| hot/cold 在途 job 索引 | 各 `64` shards、每 job 1 row | hot stage 与 cold COS publish 各自按 branch hash 分片；完成、精确 orphan cleanup、Branch GC 原子清除 | 已实现；资格查询为 O(backlog)，不扫描每个数据库的永久 CMPC 状态 |
| cold object | 最大 `4 MiB` | 单个不可变 COS object 上限 | 已生效 |
| COS 请求 admission | `16` 执行、`64` 等待、`15s` | exact GET/PUT/HEAD/DELETE 共用有界 gate；queue full/timeout 显式失败，冷读按 exact-get、hash、FDB revalidate/refill 分阶段计时 | 已实现并通过单测/40 项 cold workflow 回归；北京 SLO 收据待跑 |
| cold delete batch | `100` objects | 精确 key DeleteObjects；不依赖 COS `LIST` | 已生效 |
| harness 安全边界 | `4096` Actors / concurrency `256` | 压测工具的误操作保护，不是产品上限 | 仅测试工具 |
| API/资格测试 timeout | request `30s`、ready `180s`、quiescence `180s`；1024 gate 使用 `300s` | 测试失败判定，不是线上客户端默认 SLA | 仅资格测试 |

## 3. 当前背压链路与缺口

```text
client / load generator
  -> Rivet gateway
  -> serverful Runner allocation
  -> workerd-host 等待队列
  -> 16 个执行 permit
  -> workerd isolate
  -> SQLite / Depot
  -> FoundationDB commit ACK
```

16-slot 执行闸门和 64-slot admission queue 共同防止 activation/eviction wave 把 workerd
loopback listener 打挂。等待超过 15 秒或队列已满时，host 在 dispatch 前返回可重试的
`503 + Retry-After`；运行时统计暴露当前/峰值执行数、等待数以及 queued/rejected/timeout
单调计数。恢复验收不是只看最终 HTTP 成功：它从 sleep 后的计数起算，要求同步 wake 确实
产生 queue delta，完成后执行/等待均为零，且 reject/timeout delta 都为零。

permit 在请求发送前获取；发送后若连接 reset，host 仍不会盲目重放 SQL mutation，因为响应
丢失并不能证明 FDB commit 没有发生。当前剩余的协议工作是 gateway → host deadline budget
透传/取消，以及为需要自动重试的 mutation 增加稳定 request id 和 FDB 原子结果去重表。

### Bottomless 容量契约

**Bottomless 的正式含义是“不设置产品级固定逻辑 byte quota”**。它不是“所有层都没有
边界”：单次 commit 仍最多 320 个 dirty pages；单分支 FDB 写债以 10 MiB 为目标、12 MiB
为 admission 线；单 COS object 最大 4 MiB；SQLite 的 `u32` page number 给出约 16 TiB 的
格式边界；整个 Cell 仍按延迟、磁盘、backlog 和恢复预算关闭新 placement。

验收必须同时证明：资格数据库逻辑尺寸超过 10 MiB 写债目标；`logical_storage_limit_bytes`
为 null；写债不超过 admission 线；同一精确 branch 的 cold watermark 覆盖 head、存在 cold
ref/publish/PITR，且 staged/hot SHARD 都为零；之后只通过 exact COS GET、size/hash 校验、FDB
ref/lifecycle 重验和可选 cache refill 恢复。不能用 COS `LIST`、全局数据库扫描或“最终能读到”
代替这些证据。

Actor 生命周期命令另有一条独立的 durability 链：Engine 先把每个命令写入按
`(namespace_id, envoy_key, actor_id, generation, index)` 分片的 `ActorCommandKey`，连接中的
Envoy 定时只扫描自己的有界 prefix。pub/sub 投递在 websocket admission 后才回复。客户端
仅在命令实际进入 Actor mailbox 后推进 checkpoint，并立即回传 ACK。这样单个失联 Envoy
的补偿成本与该 Envoy 自己的 backlog 成正比，不再扫描全局 pointer 或所有 Actor。

该协议窗口现已由 commit barrier 关闭：客户端的 ACK bytes 离开进程后仍保留 dedup checkpoint；
服务端完成 FDB `clear_range` commit 后才回发 ACK-of-ACK。连接在任意一侧丢失时，客户端在新
session 的 capability barrier 后重发同一 ACK，服务端重复 clear 保持幂等；旧 barrier 也不能清除
同一 Actor 的更新 checkpoint。ACK 单批同时限制为 `512` 条，客户端逐 barrier 排空，服务端在
任何 FDB mutation 前拒绝超限或畸形输入。本地永久门禁已经覆盖 barrier 丢失重连、重复 commit、
畸形事务原子回滚和有界批处理；尚缺北京真实 Cell 在 ACK 已发送、commit/barrier 边界主动断线的
同构 receipt，因此生产资格仍保持 fail closed，而不是把单元证据外推为云上故障证据。

## 4. 单 Cell admission 策略

`beijing-fleet.yaml` 中的 `50 / 70 / 80` 由 Cell controller 应用于 Prometheus-backed
`RivetCellReport` 容量事实，并收敛为 Cell status 中的 admission/Claim 状态。Reporter 只负责
观测，不再拥有风险策略或 mint `scaleOutEpoch`；v1alpha1 Report 中同名字段仅为兼容旧 wire
shape，不能覆盖 controller 决策。该闭环已由 MeshHarness 控制面测试覆盖，但尚未接入北京真实
Cell Agent，不能视为生产流控。三个值按以下方式解释，否则会出现“降级反而允许更高负载”的歧义：

容量评估器必须为每次新的扩容决定递增单调 `scaleOutEpoch`。Claim 固定记录 Cell UID 和 epoch，
同一 epoch 只兑现一次；仅仅持续刷新一个 `AdmissionClosed` Report 不会不断购买新 Cell。

| 水位 | 策略 |
|---|---|
| `< 50%` healthy budget | 允许新 Actor placement；目标是保留恢复和 compaction 余量，而不是跑到设备饱和 |
| `>= 50%` | 停止向该 Cell 分配新 Actor；已有 Actor 继续服务；启动新 Cell 的 pending reservation |
| `>= 70%` 或任一 degraded signal | 进入保护状态：拒绝非必要 create/fork/批量 wake；限制迁移、后台回填和非紧急 compaction 并发，但不能停掉 correctness-required GC/fencing |
| `>= 80%` | 紧急阈值，不是正常 scale-out 起点；停止所有新 placement，必要时对可重试流量 shed load |

利用率不能只取一个 CPU 百分比。controller 至少应取以下信号的最大风险等级：

- FDB commit p95/p99、conflict/retry、storage queue、log queue、free disk、recovery state；
- workerd RSS、V8/SQLite/VFS 预算、host 16-slot 使用率、64-slot 等待数、queue
  reject/timeout、request deadline miss；
- active Actor、VFS binding、activation/sleep 速率；
- Gasoline runnable/dormant workflow 数和 wake/retry backlog；
- Depot hot compaction、cold publish、reclaimer、GC、reconciliation backlog；
- COS exact GET/PUT latency、错误率和冷恢复速率。

任一 correctness signal（writer fence mismatch、FDB unavailable/commit unknown 未解析、COS
对象缺失或 hash 不符、registry 无法归零）都覆盖百分比水位，直接关闭 placement。

## 5. 扩容、恢复与退役

### 扩容

- 扩容单位是独立 `RivetCell`，不是给一个无限共享的 FDB 集群持续塞机器。
- 正常 scale-out 在 50% healthy placement budget 用尽前启动；80% 只作最后防线。
- 新 Cell 只接收新 Actor（`NewActorsOnly`）。存量迁移必须使用 exact Actor IDs 和有界批次，
  当前声明 `migrationBatchSize=128`。
- pending placement 必须经过 FDB durable placement directory 的 CAS reservation；Kubernetes
  controller 只消费聚合计数并控制 admission/Cell Claim。当前每 Cell `1024`、TTL `30s` 仍未
  接入真实 placement service，不能依赖 YAML 或 status 获得事务正确性。
- 不创建 per-Actor Kubernetes 对象，不扫描全局 pointer，不使用 COS `LIST` 恢复。

### 恢复风暴

- 每批 wake 必须同时受 active-slot、host queue、FDB transaction tag、cold-read 和 COS
  refill budget 限制。
- 优先恢复最近有真实请求的 Actor；不得为了统计状态主动唤醒全冷 Actor。
- 旧 generation 的 writer fence mismatch 必须毒化连接并销毁 isolate，不能继续提供只读
  假成功。
- 至少两个 workerd host、两个 Runner 的 owner loss/rebalance gate 未通过前，不开放自动
  全量 rebalance。

### 退役

退役顺序固定为：关闭新 placement → exact placement 归零 → active writer/in-flight commit
归零 → migration/compaction/GC/reconciliation backlog 归零 → exact-key cold/backup 可达证明
→ old generation 拒写证明 → rollback retention 到期 → 明确删除 FDB、CBS、COS policy 和凭据。

删除 Pod、CVM、`RivetCell` CR 或一个 FDB prefix 都不是退役证明。

## 6. 当前容量证据

| Gate | 北京 Cell B 结果 | 能得出的结论 |
|---|---|---|
| 单 host 64 Actor | 通过；sleep 后 registry `0/0`，wake 后 generation 前进 | 小规模完整 lifecycle 正确 |
| 单 host 256 Actor，concurrency 8 | 通过；sleep settle 约 253 ms，workerd peak RSS 增量约 73.1 MiB | 当前低并发密度基线，不是上限 |
| 三 AZ 压力源，总并发 48 | 192 Actors、3072 writes 全通过，合计约 25.9 writes/s | 16-slot admission 与禁用 keep-alive 修复了已观察的 loopback reset；只证明当前 workload |
| 单 host 1024 全活跃 | SQL exactness 与 `1024/1024` registry 已通过；最终云端运行中 workerd/host/Engine peak RSS 分别约 243.55/25.26/422.45 MiB | 证明能够激活 1024，不证明长期全活跃 SLO |
| 单 host 1024 全冷再唤醒 | durable per-Envoy reconciliation 修复后通过 active `1024/1024` → cold `0/0` → generation 2 wake `1024/1024` → cleanup `0/0`；sleep settle 252.09 ms | 已关闭观察到的 lost-Stop 故障；ACK-of-ACK 已通过本地确定性门禁但云上断线 receipt 尚缺，也不代表 1M 冷元数据证明 |
| 1024 周期后的进程 RSS | registry 已为 `0/0`，但 workerd/host/Engine 结束 RSS 约 135.14/25.26/422.45 MiB；起始约 124.05/6.77/91.09 MiB | isolate 所有权归零已证明，进程内存回落未证明；必须区分 allocator high-water、cache、workflow retention 和 leak |
| COS cold tier | exact publish → 约 601s 后 hot eviction → exact GET/hash → refill 通过 | 冷降级闭环成立；首次冷读 16.747s 尚无可接受 SLO |
| Bottomless/冷读/恢复新 gate | 本地已通过：10 MiB 目标 + 12 MiB admission 回归、40 项 cold workflow、12 项 harness、17 项 workerd-host；云端默认 1 个 12 MiB 资格库 + 48 Actor 同步冷恢复 | 实现证据不是北京生产 SLO；必须生成新 release 的真实 Cell 收据后才能替换上一行的历史 16.747s |
| 一 AZ FDB 丢失 | 45.079s writer 中 165 成功、1 失败、最大成功 gap 5.601s，sentinel 正确 | 不是 RTO=0；2/2/2 也不是最终 3/3/3 复合故障形状 |

资格测试产生的 Actor 必须记录 exact manifest，并只按该 manifest 清理。禁止为了清压测数据
扫描或删除整个 namespace。2026-08-16 的 1024 失败运行最终已按 exact manifest 清理，云端
host/bridge registry 复核为 `0/0`。

## 7. 开放生产前的 P0/P1

| 优先级 | 必须完成的证明 |
|---|---|
| 已关闭 | durable per-Envoy command reconciliation 已部署复验；1024 Actor 达到 active `1024/1024` → cold `0/0` → wake generation 全前进 → cleanup `0/0`（`inv-67f7t708au`） |
| P0 | FDB commit 后的 ACK-of-ACK、有界批处理和本地断线/重复事务门禁已经实现；仍须在北京真实 Cell 注入“客户端 ACK 已发送、服务端 commit 或 barrier 返回前断线”，证明 Start/Stop 不重复且 durable backlog 最终清零 |
| P0 | 已实现有界 host queue/deadline/`503 + Retry-After`；在北京真实 Cell 通过 48 Actor exact cold-only → 同步 wake，冻结 p95 `10s`、p99 `20s`、max `30s`，并证明 queued delta > 0、reject/timeout delta = 0 |
| P0 | serverful Runner 增加 durable、每 Cell 的 active Actor admission；不能把 VFS 4096 报错当调度器 |
| P0 | 对同一精确 manifest 做多轮 active → cold → wake → delete 循环并保留分阶段 RSS/heap attribution；Engine retained RSS 必须收敛到有界平台，而不是随累计 Actor 周期单调增长；8-cycle harness/阈值已落地，北京收据待跑 |
| P0 | Set controller 已实现 Claim、placement close、bounded reconciliation 和 proof-gated retirement并通过 OrbStack；仍需把 FDB CAS reservation 接入 placement service，并完成北京 TKE/真实 Cell Agent 资格测试 |
| P0 | Cell B 扩为 `3/3/3` 并通过“一 AZ + 另一机器”以及恢复风暴测试 |
| P0 | 1M dormant 数据库的 application/Depot/Gasoline keys、bytes 与 create/open/delete p99；真实 Actor + resumable exact manifest + 离线 FDB footprint harness 已落地，北京收据待跑；100M 单独验收 |
| P0 | Gasoline dormant workflow 固定成本与长期 wake/lease/GC backlog 上界；footprint 与分片 drain harness 已落地，北京收据待跑 |
| P0 | 三 AZ runtime、两个 pool、三个实际 workerd host 下的 2K/4K active density 与 RSS 收敛；exact per-generation registry/IaC/harness 已落地，北京收据待跑 |
| P0 | FDB range split、storage-server 动态热点、range ownership；空 Cell baseline + read-only `status json`/`getlocation` growth harness 已落地，北京负载收据待跑 |
| P0 | hot compaction、cold publish、due GC、per-Envoy reconciliation 在停止输入后连续 3 个 sample 排空；永久 CMPC state 和 future-retained GC 不得被误判为 backlog |
| P0 | Bottomless 合约已实现：无固定逻辑 byte quota，FDB 写债目标 `10 MiB`/admission `12 MiB`；仍需北京 12 MiB exact cold-only 资格库收据，且后续另做远大于阈值的长期容量/成本曲线，不把本次快速 gate 当容量上限 |
| P1 | 320 dirty-page 单提交仍是硬限制；如产品要求任意大事务，另行设计 staged large commit，不得与 Bottomless 逻辑容量混为一谈 |
| P1 | 连续 FDB backup + 空白替换集群 restore；COS cold tier 不是未 publish acknowledged tail 的备份 |

## 8. 值班停压规则

出现下列任一项，立即停止增加并发/Actor 数，关闭该 Cell 新 placement，保留现场并执行
exact-manifest cleanup：

- SQL 值错误、重复 mutation、成功响应但 FDB 无提交，或 fence 后旧 generation 仍可写；
- workerd/host/Engine OOM、崩溃、非预期重启或 loopback connection reset；
- sleep/delete 超时后 registry 不归零；
- FDB 进入 unavailable/recovery 且超过资格预算，或 commit-unknown 无法确定结果；
- cold ref 指向的 COS exact key 不存在、size/hash 不符，或读取路径返回零页代替失败；
- backlog 连续增长且在停止输入后不能回到低水位；
- 任何测试需要全局 Actor、pointer 或 COS object 扫描才能判断或清理。

压力必须从北京云内发起。临时压力 CVM 只能是独立 VPC 客户端，绝不加入 TKE；TKE 工作
节点只允许腾讯云原生/标准托管节点池。笔记本只用于编排、代码和本地单元测试。
