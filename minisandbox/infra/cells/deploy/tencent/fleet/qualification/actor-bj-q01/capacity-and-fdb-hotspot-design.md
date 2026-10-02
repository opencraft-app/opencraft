# Agent 容量规划与 FDB 热点设计

本文记录 `actor-bj-q01` 的容量契约、100 Agent/s 验收边界，以及 Actor
placement 路径的 FoundationDB keyspace 审查。它是生产分片参数的设计依据，
不是一次压测结果的宣传口径。

## 容量契约

一个 workerd Host 有两个不同的数字，不能混用：

- `32 active Actors/Host` 是 placement 的硬上限。达到上限后 Engine 不得再向该
  Host 分配 Actor。
- HPA `AverageValue=16` 是名义运营水位，相当于正常状态保留 50% 的 active Actor
  余量。TKE 当前 HPA 按 Kubernetes 默认 10% tolerance 防抖；资格门禁把 10% 当作
  可接受上限，而不是声称能够从 HPA 对象读取这个 controller 全局参数。
- q01 基线为 3 个 Host，最大 30 个 Host；Host Pod 与 TKE runtime node 是 1:1。
- HPA 只负责扩容。缩容由串行 drain 状态机完成，并且一次最多回收一个 Host。
- Host drain 完成后，Node 缩容必须走腾讯云
  `DeleteClusterMachines(MachineNames=[exact], EnableScaleDown=true)`。实际 q01
  已证明仅修改 MachineSet replicas 即使配置 `deletePolicy: Newest` 也可能删除
  另一台承载 Host 的 Machine，因此该路径被永久禁止。
- 精确缩容先在 MachineSet annotation 持久化 Machine/Node/MachineSet UID 与
  desired hosts 快照、from/to replicas。每次 `to = from - 1`，即使 HPA 已经从
  峰值直接回到 3，也必须按 `peak→peak-1→...→3` 串行执行；不能错误地要求单步 `to` 等于最终
  HPA 目标。`prepared` 和尚未产生 HTTP attempt 的 `issued` 都必须在 HPA 目标
  变化时撤销；已有 attempt 的 `issued` 只能观察收敛。由于
  API 没有调用方幂等键，任何已经持久化的 HTTP attempt 都不得重复提交；Machine
  与 Node 均消失且副本数精确下降后，必须在同一 JSON Patch 中清理 intent 并写入
  `runtime-capacity-last-downscale-receipt`。v2 receipt 保留 exact UID、from/to 与
  attempt，并显式区分两种互斥结果：收到 RequestId 时为
  `provider_acknowledged`；响应丢失但精确 Machine/Node 已消失且容量精确收敛时为
  `observed_exact_convergence_after_ambiguous_response`。后者必须没有伪造 RequestId，
  且 attempts 必须等于 1。缺少 outcome、两种证据混用或任何第二次 provider 调用
  都必须 fail closed；资格采集器再把每一步转存为不可变外部证据。

因此稳定态目标为：

```text
nominal_desired_hosts = clamp(ceil(active_actors / 16), 3, 30)
qualified_scale_up_floor = clamp(ceil(active_actors / (16 * 1.10)), 3, 30)
hard_capacity = ready_hosts * 32
warm_headroom = hard_capacity - active_actors
```

名义目标是软水位，HPA 可在 10% deadband 内保持当前副本数；资格测试要求实际副本
不少于 `qualified_scale_up_floor`。`hard_capacity` 才是 admission 边界。扩容中的 Pending、
NotReady 或缺少有效 Pod IP 的 Host 不计入可用容量；控制器证据不完整时必须
fail closed。

## 100 Agent/s 的准确含义

当前门禁是“一秒内均匀到达 100 个新 Agent，上传已经完成，测量 object create
到第一次 JS fetch 可用的完整路径”。每个 Agent 的
`scheduled_to_chat_ready_seconds` 必须小于 3 秒，模型推理时间不在此 SLO 内。

门禁先用 80 个 Actor 将集群预热至 5 个 Host，再让它们休眠；此时 5 个 Host
提供 160 个硬 slot，足以接住随后一秒内的 100 个 active Agent。负载到达后 HPA
按运营水位把集群扩到至少 6 个 Host；如果采样越过 deadband，扩到 7 也同样正确。
TKE node provisioning 是单独的 elasticity
指标，不能伪装成三秒 ready SLO 的一部分。

这证明的是 100/s 的有界突发，不是无限持续 100/s。给定突发大小 `B`：

```text
最低即时 admission Host 数 = ceil(B / 32)
名义 50% 水位 Host 数 = ceil(B / 16)
允许 10% HPA deadband 的最低 Host 数 = ceil(B / 17.6)
```

对于持续流量，还必须把云节点交付时间 `T_node` 纳入队列和预热策略。若 Actor
在这段时间内不休眠，仅靠反应式扩容需要约 `rate * T_node` 个预先空闲 slot，
成本通常不可接受；生产上应使用预测性 warm floor、有界 admission queue 和
明确的 overload rejection，而不是承诺任意时长的 100/s 都在三秒内完成。

## FDB keyspace 审查

FDB 按有序 key range 自动切分。长公共前缀并不自动等于热点：前缀后有高熵
Actor ID 或 hash position 的 range 可以被分裂到多个 storage server；单个精确
key 无法被 FDB 再切分，增加 storage 节点也不会消除它的事务冲突。

| key / 路径 | 访问形态 | 判断与约束 |
| --- | --- | --- |
| Actor 生命周期和状态 key | 以随机 Actor ID 为后缀 | 可按 range 散列；正常数据面不应有 Cell 级单 key |
| `ActiveActorKey` / `AllActorKey(namespace,name,create_ts,actor)` | 同一 Worker name 下按创建时间递增写入 | 不产生单 key 事务冲突，但最新写会形成移动的 range 尾部热点；100/s 已通过，继续放量前要观察该 range 的 storage-server 归属，并准备按 `hash(actor_id) % N` 分桶、查询时 k-way merge |
| `EnvoyHashIdxKey(namespace,pool,version,hash_pos,envoy)` | hash ring range scan，`hash_pos` 为 128 bit | 可切分且保留有序扫描语义；不要为了“看起来分片”再加破坏 range scan 的 salt |
| `ActorCapacityKey(namespace,envoy)` | allocation 读取，Host 注册/容量改变时写 | 按 Host 分散，写频率低 |
| `SlotsKey(namespace,envoy)` | 每次 placement 对选中 Host 做 serializable reservation | 精确硬上限所需，但 bin-pack 会把并发写集中到一个 Host key；这是当前主要冲突点 |
| `ActorSlotsKey(namespace,pool)` | 每次 start/stop 做 atomic add；配置全局并发上限时做 serializable read | 单 key 物理写热点。q01 Normal Envoy 不使用 pool 级硬上限，因此当前不会因读写冲突串行化；启用 hard cap 时必须精确串行化，不能用 snapshot read，否则并发事务会共同越过上限。规模化方案是预分配有 fence 的 slot credit，不是近似计数 |
| hash ring highest-version / 配置 key | allocation 高频读，发布低频写 | 读热点可由客户端/cache 承担；不得让每个 Actor 创建都改版本 key |
| Gasoline `WorkflowWakeConditionKey` | deadline/immediate 队列按时间扫描 | 已按稳定的 `hash(workflow_id) % 32` 分桶；worker 对 32 个 shard 有界扫描。这是正确的时间索引散裂方式 |
| Gasoline 全局 `MetricKey(workflow_name,state)` | 每次 workflow 状态变化做 atomic add | 不产生事务冲突，但同名 Actor 全写一个物理 key；100/s 可接受，继续放量前要用 FDB storage hot-key 指标验证。超过单 key 写带宽后改为固定 counter shards，publisher 汇总 |
| Gasoline lease/metrics GC lock | 周期性 leader election | 单 key 是有意的一致性点，不在每 Actor 热路径；不能为了散裂产生多个并发 GC leader |

### 为什么不能简单“给 SlotsKey 加 salt”

每 Host 的 32 是安全上限。若把一个 Host 的计数任意拆成多个互不协调的 key，
并发分配可能让分片分别通过检查，合计超过 32。可接受的设计只有两类：

1. 保留一个可串行化的 Host reservation key，并减少竞争者同时选择同一 Host。
2. 预先把不重叠的 slot/credit 分发到多个 reservation bucket；回收、Host 降容、
   drain 和崩溃恢复都必须证明 credit 不重发。这是更高吞吐阶段的独立协议，不能
   用近似计数冒充硬容量。

当前采用第一类。

为避免把 100 Agent/s 的突发直接放大成同一小组 `SlotsKey` 上的随机重试长尾，
Engine 还按 `(namespace, pool)` 设置进程内 placement 并发门。q01 生产值为每个
Engine 每个 pool 一笔；三个 Engine 仍提供三路并行。它只负责整形，不拥有容量：
事务获得本地 permit 后仍必须对 FDB 中所选 Host 的精确 `SlotsKey` 做 serializable
读取和原子预留。因此 Engine 崩溃不会遗留或重复发放 slot，跨 Engine 竞争仍由 FDB
裁决。端到端三秒门禁同时约束排队时间，防止通过无限排队伪装冲突改善。

## 热点修正

正常、无冲突的第一次 allocation 仍使用 power-of-two choices 和 bin-pack，保证
低密度与后续缩容效率。若 FDB 因同一 Host `SlotsKey` 冲突而重跑事务，重试使用
更宽但仍有界的 hash-ring 样本：

```text
attempt 0: samples=2 + bin-pack + slot jitter
attempt 1..N: samples=min(max(samples*2, 4), 8)，重新随机采样，在所有未满候选中均匀选择
commit: serializable read SlotsKey + atomic reservation
```

这不是放松一致性。每次重试仍在同一 FDB transaction 内重新检查
`ActorCapacityKey` 和 `SlotsKey`，并原子预留 slot；变化的只是发生冲突后选择哪个
Host。重试不能继续按 best-fit 选择样本中最满的同一 Host，否则多个 Engine 会再次争用
同一 `SlotsKey`；也不能退回单样本，因为它命中满 Host 时会在其他 Host 仍有空间时制造
不必要的 `NoEnvoys`。均匀选择只发生在已经观测到真实 FDB 冲突之后，并且仍排除 full、
draining 和缺少容量契约的 Host。正常首轮继续 bin-pack，也不在热路径无界扫描全 pool；
首轮 K=2 偶然只采到满 Host 时允许返回一次有界容量背压，由 Actor workflow 在新快照上
重入。

`slot_jitter=16` 作为首轮选择的去相关参数保留，但不能把它当成根治。2026-09-04
的负向门禁中，`slot_jitter=4` 出现一次 `pegboard_actor2_acquire_slot` 十次重试
耗尽，100 个 Agent 的最大 chat-ready 为 3.779 秒。只改成 16 后虽然未再出现显式
耗尽，181 次 allocation 仍消耗 421 次事务尝试，两个事务达到 9--10 次尝试，
说明必须使用自适应冲突恢复。

同一测试在 `slot_jitter=16` 下的参数实验通过：100 个 Agent 在 0.99 秒内到达，
chat-ready p50/p99/max 分别为 1.018/2.020/2.410 秒，HPA 与 MachineSet 从 5 扩到
7，负载结束后按 `[1,1,1,1]` 串行回到 3，180 个测试对象全部精确删除。该结果
只证明参数缓解和完整弹性链条，不取代下面要求的自适应算法正向门禁。

## 运营指标与门禁

每次正式资格测试至少保留以下证据：

- Agent 到达调度误差、create、first fetch、scheduled-to-chat-ready 的
  p50/p99/max；任何样本超过 3 秒即失败。
- `rivet_udb_transaction_attempts{name="pegboard_actor2_acquire_slot"}` 的 count、
  sum 和 bucket。正式门禁要求平均尝试数不超过 2，至少 99% 的事务不超过 5 次，
  且 100% 不超过 8 次。不能用“小样本里恰好没有一笔超过 5 次”的随机最大值替代
  分位数 SLO；也不能仅凭 p99 掩盖一次重试耗尽。
- `rivet_envoy_lb_retry_fallback_total`，证明冲突恢复路径实际执行。
- `rivet_envoy_allocation_gate_wait_duration_seconds`，证明本地整形没有把冲突长尾
  变成不可见的排队长尾。v4 要求平均等待不超过 250 ms，超过 1 秒的事务不超过
  10%；端到端 3 秒 SLO 仍是更高层硬门禁。
- `rivet_pegboard_actor_allocate_duration_count{result=...}` 区分成功 placement 与
  扩容窗口内暂时无 Envoy 的重入。成功数必须与测试 Object 数精确相等；每次
  allocation 必须恰好对应一次 gate 和一次 FDB transaction。每次暂时未分配必须
  同时一一对应 `rivet_envoy_lb_no_envoy_available_total` 和
  `rivet_envoy_lb_capacity_rejected_total`，不能把未知错误算作容量等待；总 placement
  工作放大不得超过 1.25x。不能错误地要求内部 transaction 数恒等于 Object 数，
  否则会把可恢复的概率采样背压误报成用户请求失败。
- 每个 Host 的 active Actor 分布、硬容量拒绝数、HPA desired、Ready Host、
  Pending Pod、MachineSet desired/ready。
- Engine 的 `max number transaction retries reached` 必须为 0。
- 负载结束后必须逐台 drain 回到 3 Host/3 node，Actor 精确删除，FDB
  `available=true`、`fullReplication=true`，连续备份仍 `restorable=true`。
- 资格流程失败也不能在云容量仍回收中时释放高风险 operation lock。失败路径必须先
  精确删除测试 Object，等待 active Actor 归零，再等待 Host、MachineSet、Node
  全部回到 3 且没有 provider intent；恢复结果与原始失败原因一并进入 receipt。

以下现象必须分别处理，不能用同一个“扩 FDB”解释：

- 单个精确 key 冲突：修改 reservation/调度协议；扩 storage 节点无效。
- 高熵 key range 的读写吞吐饱和：检查 shard/range 分布后再扩 FDB。
- Engine CPU、连接池或 Gasoline backlog：扩 Engine 或修工作队列。
- workerd hard slots 不足：扩 runtime Host/node，并保持 admission fail closed。

### 冷唤醒 overflow 长尾

2026-09-05 的首轮 `production-cell` Bottomless 资格在 48 个对象中出现两个
冷唤醒长尾，分别约 11.9 秒和 22.5 秒，因 p99 超过 20 秒而正确失败。COS
有界队列等待、对象读取、完整性校验和 FDB 热回填都在毫秒到数百毫秒范围；
长尾集中在同一个 Engine Pod 的 SQLite `get_pages`。

根因是 SQLite 大 BLOB 的 overflow chain：旧实现从 leaf 页开始，每得到一个
overflow 页才知道下一个页号，并为每一页发起一笔新的 UDB 事务。12 MiB 值可由
约 3,000 个 4 KiB 页组成，单次预取虽然有 2.5 秒保护上限，但 workerd 会继续
请求余下链段，最终把多个 1--2.6 秒片段叠加到一次对象唤醒。

修正后的不变量为：

- overflow 指针仍逐页验证，但物理读取按最多 1,024 个相邻页（4 MiB）批量完成；
  Depot 在批内并行解析其 256 KiB storage shard，不能退回一页一事务。
- 每个嵌套批次携带外层 `head_txid` fence；并发 head 变化必须失败，不能拼接两个
  SQLite 版本的页。
- 实际追加的 overflow 页仍受 2,048 页和 2.5 秒双重限制；碎片链跳出当前窗口时
  才开启下一批。
- Pegboard Envoy 根据协商的 WebSocket payload 动态分配“请求页 + overflow 页”
  总预算，并预留序列化空间；不可信 runner 不能借 overflow 扩展突破响应上限。
- `rivet_sqlite_conveyer_overflow_prefetch_duration_seconds`、
  `rivet_sqlite_conveyer_overflow_prefetch_batch_pages` 和
  `rivet_sqlite_conveyer_overflow_prefetch_expanded_pages` 必须进入冷唤醒观测。

本地 2,048 页（8 MiB）连续链回归测试只证明算法不再逐页往返；它不替代北京
真实 COS/FDB 的同版本 Bottomless 复跑。旧失败 receipt 必须保留，只有新镜像在
相同 20 秒门槛下通过才可恢复该项生产资格。

2026-09-06 的后续正式运行
`actor-bj-q01-bottomless-production-cell-public-0dd1c561cfd34e07a68cadd47639c04f.json`
（SHA-256 `d0d7314a586d092e8d4e972b173f5b05ec1115a2a14d3f4f32f459eb07d2f87a`）
已经越过 exact cold-only 门并开始 48 路同步唤醒，但首个 12 MiB Agent 被 workerd
以 `EventOutcome::EXCEEDED_CPU` 拒绝。失败不是 COS/FDB 数据缺失：workerd 日志显示
generation 2 已进入 Running，随后在约 4 秒处触发 CPU watchdog；测试按 exact
manifest 清理且 `cleanup_errors=[]`。

根因是 Host 仍使用旧 Workers Bundled 时代的固定 50 ms CPU ceiling。当前 Workers
Paid、Durable Objects 与 Agents 的默认 invocation CPU budget 是 30 秒；异步 I/O
等待不计 CPU，但同步 SQLite、哈希与 VFS 处理会消耗执行线程 CPU。平台因此固定以下
发布不变量：

- 动态 Worker 默认 CPU budget 为 30,000 ms，V8 heap 仍为 128 MiB；
- CPU 超限仍由 workerd 强制终止，不通过 HTTP 自动重试掩盖副作用；
- 新默认必须由真实 12 MiB cold wake 复验，不能仅凭单元测试恢复生产资格；
- 后续若开放用户自定义 `limits.cpu_ms`，它必须进入 immutable Version 身份并通过
  expand/contract 混合版本发布，不能让同一个 Version 在滚动升级中获得不同预算。

同轮透明升级还暴露出一个控制面所有权错误：公共流量把 runtime Host HPA 从三副本
临时扩到四副本后，自治审计复用了资格测试的“恰好三个 Ready Pod”绑定器，因而把
健康的动态容量误判为审计程序崩溃并关闭 Cell。修正后的边界是：Engine 发布拓扑仍
严格为三副本；runtime StatefulSet 的副本数由 HPA/drain controller 所有，自治审计
允许 3--64 个 Ready Host，并验证每个 Ready Host 以及尚未 Ready 的扩容 Pod spec
都绑定当前不可变 release。资格测试仍使用固定 Pod 集合模式，扩缩容中的 Pod 不能
混入 Bottomless、HA 或恢复收据。

首轮物理恢复资格 `4acfafb75bf14a62871fa70b0faa4090` 在 seed 阶段按预期失败：
12 个 Agent 的 cold watermark 均已追上 head 且 cold shard 已发布，但旧脚本把 exact
cold deadline 固定为 600 秒，每个小 Agent 仍有 1 个 hot shard 时超时。失败 receipt
SHA-256 为 `6645a56dfc66c9243d16c4f231581996c492e68bf48a19e84813074c05c78f35`；
它没有创建 DR 目标，源 Agent 保留。DR 的 qualifier 与最终 freeze 复核现在共享显式
`DR_COLD_STATE_TIMEOUT_SECONDS`，production 默认 3600 秒；该参数只控制等待截止时间，
不能缩短真实 reclaim 周期或把 e2e-fast 行为冒充生产证据。

2026-09-04 参数实验回收后的 FDB `status json` 快照显示：集群估算事务上限约
109,392/s，采样时 committed 约 2.6/s，`performance_limited_by=workload`，自动和
手工 throttled tag 均为 0；集群同时为 available/full replication。这个快照不是
峰值容量证明，但足以排除“本轮是 FDB 集群整体吞吐饱和”的解释。资格脚本观察到的
重试耗尽必须按精确 key 冲突处理。

负向基线 receipt 为
`q01-agent-arrival-rate-e0cd1040.json`，SHA-256
`b20e99db90264386712dbd5df9f7fe546b6428257102e1afb019e8a053f716d0`。
参数实验正向 receipt 为 `q01-agent-arrival-rate-jitter16-r1.json`，SHA-256
`c306f1959232ba086c0661bb3dc0260a26ce6ebd542cedacb9f6c9d186c36733`。
2026-09-07 的正式 v4 正向 receipt 为
`actor-bj-q01-agent-arrival-20260907T122919Z.json`，SHA-256
`2f87ca3676204d89ba7510c3eada0f201d6e5b39282486fcd0a9145afb6cad22`。它通过公共
`/v1` DO API 在一秒内调度 100 个新 Agent，chat-ready p50/p99/max 为
0.926/1.517/1.800 秒；180 次成功 placement 产生 18 次全部可解释的容量背压，
工作放大 1.10x，allocation gate 平均 109 ms 且没有一次超过 1 秒，FDB 平均尝试
1.273 次且全部不超过 5 次。HPA/StatefulSet/MachineSet 达到 6 后按 `[1,1,1]`
精确回到 3，每次 provider 删除均绑定 Machine UID、Node UID 与 request ID。

`envoy_allocation_max_in_flight_per_pool=1` 因而已证明是安全可用的 q01 bootstrap
生产值，但不是吞吐最优值。完成 DR 资格、重新开放配置发布后，应在相同 runtime
digest 下依次发布 2/4/8 三个单变量配置，仍用 v4 receipt 比较用户 SLO、工作放大、
gate 等待和 FDB 冲突；不得把直接调到 32 当成扩容方案。

2026-09-14 的透明升级门禁进一步区分了“分配整形”与“错误生命周期语义”。Host
发布零容量后曾同时为本地 Actor 发送 `ActorIntent::Sleep`，而 Engine 已经根据同一
零容量元数据发送 `GoingAway`。actor2 对这两个并发意图的正确合并结果是
`SleepIntent`，因此对象不会主动迁移，只会等下一次请求冷唤醒；32 个轮询对象的尾部
自然超过 10 秒客户端期限。修复是让 Host 只负责本地 admission fence 和零容量发布，
由 Pegboard 独占 `GoingAway`/重分配。这个故障不能靠提高
`envoy_allocation_max_in_flight_per_pool` 掩盖；该参数仍保持已经通过 100 Agent/s
门禁的 1，后续 2/4/8 实验继续作为独立的吞吐优化。

## Gasoline 空间预算与历史回收

### 不要把四种“GB”混成一个数字

空间运营必须同时展示以下互不等价的口径：

1. FDB 应用层 key/value 逻辑字节，用于判断哪个 keyspace 在增长。
2. FDB storage process 实际磁盘字节，包含复制、存储引擎、版本与碎片开销；这是
   CBS 容量门禁，但不能反推为某个 Agent 的数据量。
3. FDB backup repository 的快照与日志累计字节；它受备份 retention 管理，不是
   当前在线数据集大小。
4. COS cold object 的 live/retired/deleted 字节；它是 Depot 数据成本，不包含
   Gasoline 工作流元数据。

2026-09-07 的物理恢复隔离库提供了当前基线。恢复前源 FDB 的应用层估算为
`2,935,697,627 B`，storage process 合计使用 `12,223,532,056 B`；备份恢复累计读取
`8,139,428,530 B`。这三个数字描述三个不同边界，不能表述为“12 个 Agent 使用几十
GB”。12 只是 DR 抽样对象数；该资格 Cell 历史上已经创建 `24,544` 个 Actor。

对恢复库做 raw key/value 归属统计得到：

| 归属 | 逻辑字节 | keys | 占应用层比例 |
| --- | ---: | ---: | ---: |
| Gasoline | 2,883,747,285 | 29,979,340 | 98.05% |
| Depot | 26,340,085 | 194,395 | 0.90% |
| 其他 | 30,924,855 | 395,842 | 1.05% |

隔离库仅删除七类已完成工作流的 history 后，Gasoline 降至 `653,315,997 B`，Depot
保持不变，公共 `/v1` 对原 12 个 ObjectRef 的状态验证仍全部通过。一次操作回收约
`2.23 GB`，即原应用层数据集的 `75.8%`。证据为：

- 物理恢复 receipt：`actor-bj-q01-dr-physical-restore-20260907T134114Z-8887a6f2.json`，
  SHA-256 `e450e19edec7be3bcf09c4f988426b3d51f42d8df0d0e5bd96c9ca991d0e9f78`。
- 恢复库 footprint receipt：`actor-bj-q01-dr-footprint-20260907T134114Z-8887a6f2.json`，
  SHA-256 `dbb82c1b3422f9150f9d0a5b8dbf9cee1b0ae78efd847f1b3d44f3bc2262a9a4`。

这些值可以用于暴露问题量级，但不能冒充稳定的单 Agent 定价。按历史 Actor 总数
粗分，裁剪前约 `117.5 KiB/Actor`，裁剪后约 `26.0 KiB/Actor`；工作流种类、重试、
对话次数和生命周期长度都会改变斜率。生产门禁必须再通过公共 `/v1` 创建一批全新
Agent，测量同一批对象从创建、聊天、休眠到 history 回收后的差分，而不是继续拿
混合历史库做除法。

### 为什么七天默认值不可用于高到达率 Cell

若未经校准地把当前 `117.5 KiB/Actor` 斜率外推到持续 `100 Agent/s`，一天会产生约
`1.0 TB` FDB 逻辑写入；仅可回收 history 部分也约 `785 GB/day`。即使把完成历史
保留缩短到一小时，稳态待回收 history 仍可能约 `32.7 GB`。因此：

- 扩 FDB 只能延后耗尽，不能修复生命周期垃圾的无界增长。
- `gasoline_prune_eligibility_duration=7d` 只能作为低流量开发默认值，不能成为
  100 Agent/s 分片的生产策略。
- 高频全 keyspace 扫描也不是解法；线上回收必须由完成时写入的有序索引驱动。

### 两阶段所有权

完成工作流的可回收数据必须分成两个阶段：

```text
workflow complete
  -> history eligible：删除可重放执行轨迹，保留 state/output/index
  -> terminal eligible：恢复/引用窗口到期后删除剩余工作流数据
```

`history` 阶段只处理已经提交 `CompleteTs` 的工作流。它不得删除 result/output、Actor
目录、当前 generation、SQLite head、Depot 引用或仍被父工作流消费的状态。`terminal`
阶段继续服从较长的恢复窗口和现有 `PruneVariant`；`PruneVariant::None` 永远不能被
平台策略覆盖。每个阶段都需要独立、有序的完成索引和可恢复 cursor，不能用定时全库
扫描。处理必须幂等：崩溃前后重复清 history 或终态数据得到相同结果。

### 产品级 GB 门禁

`StorageProfile` 最终应携带 Gasoline 空间策略，而不是只描述 Depot/COS：

```text
GasolineRetentionPolicy {
    history_grace
    terminal_grace
    prune_interval
    max_workflows_per_batch
    history_soft_bytes
    history_hard_bytes
}
```

配置身份必须进入 Cell 的 durable policy binding；不同 Cell 可以选择不同恢复窗口，
同一个 FDB namespace 只能有一个所有者。软水位提升回收并限制新建速率；硬水位停止
新的 Agent admission 并返回可重试的容量错误，已经存在的 Agent、回收器、备份和
恢复流量优先。不得在硬水位通过不安全删除换取可用性。

正式 profile 的具体秒数和 GB 数不在没有斜率证据时拍脑袋固定。首个生产资格门禁
先采用以下相对约束：

- 完成 history backlog 不超过 Cell FDB 逻辑预算的 10% 时为正常，10%--20% 告警并
  限制 admission，达到 20% fail closed。
- FDB 物理剩余空间、backup 可恢复性和 history backlog 任一失真时，禁止自动扩大
  admission；不能用应用层逻辑字节代替磁盘水位。
- 每次发布测量 `bytes / 1k arrivals`、回收后 `bytes / dormant Agent`、最老待回收年龄、
  prune throughput/error/retry；斜率连续两个窗口增长即阻断发布。
- q01 当前负数 active/sleeping gauge 不可作为门禁。代码修复只阻止继续漂移，存量
  计数必须由 durable state 重建后，Grafana 与自治控制才能重新信任该指标。

上述比例是保护小 Cell 的 bootstrap 门禁，不是最终计费模型。获得全新公共 `/v1`
批次的差分证据后，再把它转换为每百万 Agent arrival、每百万 dormant Agent-day 和
每 GiB 用户 SQLite 数据的容量/成本参数。

### q01 策略发布证据

2026-09-08，生产 profile 的 `history_grace=900s`、`terminal_grace=604800s` 与
`prune_interval=60s` 已通过 Git → Argo Hook → approved TAT command 发布。发布期间
公共 `/v1` 连续完成 `7,444` 次请求，32 个持久 Object 状态连续，Engine 与 Host
均完成三副本 UID 替换；发布 run ID 为
`09b108163add94af043e84f6d9ee0977`，Git revision 为
`9a33279041f9a26fc8a7d9d255d4cc4695475fb5`。完整升级 receipt SHA-256 为
`10a71c3853813d53ad4d47ee840ea1335af6f41579f4b5f8d6ef5e2f78e9fa8c`，Argo 来源链
receipt SHA-256 为
`de490cf98b490fadbc326e0922abc121245ae33d8d6332f53f3cf3c61525a5dc`。

发布后的首个观察窗口中，FDB 应用层逻辑字节由 `2,948,142,127 B` 降至
`2,946,070,128 B`，FDB 保持 healthy、无 transaction conflict 与 queued-too-long。
该约 `2.07 MB` 下降只证明新版有序索引路径正在回收新完成 history，不代表历史资格
数据已经全部清理。旧版本完成的 workflow 没有 `HistoryPruneIdx`；它们继续由旧
`PruneIdx` 在七天 terminal grace 到期后按原 `PruneVariant` 语义处理。不得为追求仪表盘
立即下降而在线全库回填或跳过恢复窗口。

回收器另外暴露低基数的 history/terminal throughput 与 last-success 指标。Hub 仅联邦
Cell 聚合，中文存储面板显示回收吞吐和距上次成功时间；期望 Ready 的 Cell 连续五分钟
没有最近五分钟内的成功 prune chunk 时触发 critical gate。全量 `rivet-engine wf list`
已经在该规模下达到 FDB transaction retry 上限，因此明确禁止把它作为线上健康探针。

每个 Engine 在 bootstrap 时主动注册这组指标，初值保持为零；只有真实成功的
`PruneChunk` 才能推进 `last_success_seconds`。因此滚动后的状态含义是确定的：series
缺失表示旧 runtime 或抓取链路故障，series 存在但时间为零表示本代 Engine 尚未观察到
成功 chunk（包括继承旧 interval 形成的持久 sleep），正时间戳才表示真实执行成功。
由于 pruner 是唯一持久 workflow，Spoke 必须对各 Engine 的 last-success 取最大值。

2026-09-08 的可观测性发布分成两个独立事务。第一笔将 prune 指标实现发布为 runtime
`sha256:16ec6642771ec771833807b140277d8f230649e5252b67c801c56da1c06b7e18`，在
`10,313` 次公共 `/v1` 请求与 32 个持久 Object 连续性下通过；run ID 为
`b46b59b2c03d1427617737c72c0e049e`，升级 receipt SHA-256 为
`e9b7b05927a6465c1938e5a992ade6913182c0cd03ea762235c82dc3fcceec6d`，Argo 来源链
SHA-256 为 `79e81f27650db0e1daf896f07b7c27a218736dbd82ddd5cb9d6900ed561b94e3`。

线上验证发现 lazy metric 在唯一 pruner 继承旧持久 sleep 时会完全缺失，因此第二笔
仅增加 Engine bootstrap 的 eager registration。第一次 attempt 因三个成功 HTTP 200
请求分别达到约 `3.148--3.156s` 而触发 3 秒硬门禁，平台自动回滚到 `16ec...`；回滚
期间 `6,314` 次公共请求与 32 个 Object 连续，失败升级和成功回滚 receipt SHA-256
分别为 `9e9ca9ca8ab5667c4e37c09ff7a166be527e5e38aa27bfb9b71b6dc3e9b86bd7` 与
`2e6b8721509c63da94215efb95b6b3d2e92e8be3978b93ae4c5f216d99025c40`。未放宽门禁；新
release attempt 最终以 `6,859` 次公共请求通过并发布 runtime
`sha256:0c4b9769c3e75bf1e4b6cb5d8867806ca056be1bd17ca7ed8251424090726b06`。成功 run ID
为 `cd02c3a4c37df95ff29933da1036d910`，Git revision 为
`aec94c8c1a3673772c64539c8fe500be19ce86b9`，升级 receipt 与 Argo 来源链 SHA-256
分别为 `34d28cdbb57d24b0fe9bf5f499f54bffbb924e2ee94918fb086f7896ed1f0d05` 和
`e6c135588733c04b9321354a052faca260992c28f714274653c22f8977dcb590`。发布后 Prometheus
精确看到三个 Engine raw series 均为零，Spoke 聚合 series 为零：抓取链路已知正常，
而真实 pruner chunk 尚未在本代进程执行。

后续 exact-index 检查定位到唯一 pruner
`1s9eetm2z0brja1ylx1agu9s5bcl00`：它仍在重放发布前持久化的 sleep，deadline 距当时约
6.5 小时。对该 exact ID 执行一次 wake 后，首轮 transaction 删除 `896` 条已到期
history，`last_success_seconds` 从零变为 `1788816378`，新的 durable deadline 收敛到
60 秒；下一周期又在 `1788816438` 成功执行，没有新的到期条目。reviewed
`kick-gasoline-pruner.sh` 随后在真实 q01 再次通过，且索引查找最多读取两个条目、要求
唯一 sleeping owner，不能退化为全 workflow 扫描。

这也明确了发布边界：Engine 重启不能改写已经记录的 workflow sleep，retention/interval
策略发布成功后必须主动 kick；但缩短 history 或 terminal retention 是不可逆删除授权，
不能混入可自动回滚的普通镜像发布。`release-runtime.sh` 现在先比较 live/new 配置，普通
发布只允许 retention 相同、延长或关闭，然后在 rollout 与 health gate 通过后自动执行
indexed kick。缩短窗口必须由后续独立 StorageProfile policy activation、备份围栏和
审计 receipt 授权。

`RivetCellProfile.spec.gasolineRetention` 现已成为 q01 的唯一策略所有者，绑定内容为
`900s / 604800s / 60s`，以及 `40 GiB` 逻辑软水位、`60 GiB` 逻辑硬水位。普通 runtime
发布会沿 `RivetCell -> ShardClass -> RivetCellProfile` 校验名称和完整 spec digest，再从
该 immutable binding 读取三项运行时参数；环境变量若与 profile 冲突会直接失败。因此
以后不能再靠一次发布命令悄悄改变 retention。

Cell Reporter 从 Spoke Prometheus 读取唯一、带 Cell label 且新鲜的
`actor_fleet:cell_fdb_logical_bytes`，Fleet controller 才拥有策略决策：达到软水位时
`AdmissionClosed`，达到硬水位时 `Emergency` 并推进既有 scale-out epoch。已有 Agent、
pruner、backup 和恢复流量不受 admission close 影响。series 缺失、重复、过期或 profile
只配置一半都会 fail closed。40/60 GiB 是 q01 启动门禁，不是最终单位经济参数；后续应
以公共 `/v1` 批次的 `bytes/1k arrivals` 和 prune 斜率校准，但无需为此伪造在线
“history bytes”指标。

同一观察窗口的在线水位是 FDB 逻辑数据约 `2.96 GB`、storage process 物理使用约
`12.22 GB`、最小 storage headroom 约 `198.10 GB`；过去一小时/六小时逻辑数据分别增长
约 `6.24 MB`/`25.69 MB`。这些是整个资格 Cell 在大量发布与容量测试后的水位，不能除以
当前可见的少量 Agent 当作单 Agent 成本。history pruner 已阻止新垃圾继续按旧周期积累；
七天 terminal grace 内的剩余状态以及旧版本没有 `HistoryPruneIdx` 的存量仍需按既定恢复
窗口自然回收。

### 每分支周期任务必须错峰

2026-09-18 的 10K shared-Agent 资格在 6 Engine、20 Agent/s 下创建 `10,000/10,000`
对象且维持 `1,000/1,000` 活跃对象，但出现 20 次三秒 ready SLO 超限。超限不是随机散布：
它们集中在约 `1,805--1,877`、`4,158--4,303`、`6,641--6,721` 三段，相邻波峰恰好
间隔约 120 秒；最大 ready latency 为 `5,139.65 ms`。这与 Depot manager 固定的
`MANAGER_COLD_COMPACTION_INTERVAL_MS=120000` 完全一致，证明单纯增加 Engine 副本不能
消除大量 branch workflow 同相唤醒造成的周期性 compaction storm。

因此所有按 database branch 执行的 cold/reclaim 周期现在用 `database_branch_id` 的稳定
哈希分配相位，实际间隔落在配置均值的 `50%..150%`，cold 与 reclaim 使用不同 hash
domain。它不改变平均周期、删除资格、FDB/COS 正确性或强制 compaction 语义，只把批量
signal pull 造成的共同 planning clock 打散。生产资格必须继续要求 ready breach 为零；
禁止通过提高 3 秒阈值、降低 arrival rate 或在压测期间关闭 cold path 掩盖该问题。
