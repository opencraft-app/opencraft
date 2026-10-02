# Durable Object 空闲休眠与冷降策略

本文定义当前 workerd Durable Object/Agent 的计算驻留、持久状态冷降和再次唤醒语义。
它描述生产默认值、判定真值、所有权与安全不变量；资格测试为了缩短时间而使用的参数不属于
生产策略。

## 1. 结论

平台把“冷”拆成三个彼此独立的状态：

| 状态 | 释放的资源 | 当前生产判定 | 仍然保留 |
|---|---|---|---|
| Active | 无 | Actor 已分配并由一个 workerd Host generation 服务 | isolate、SQLite/VFS binding、placement slot |
| Sleeping | 计算驻留 | 30 秒内没有新请求使 idle candidate 失效，且判定时活动请求数为 0 | Object/Actor ID、SQLite 数据、Worker/Deployment 引用 |
| Cold-backed | COS 已有可验证冷副本 | Depot 在新的持久写入安静约 2 分钟后运行 cold compaction | FDB 热页缓存可以继续保留 |
| Cold-only | FDB 热页缓存 | 默认数据库 7 天未被访问，且 reclaim 证明冷副本、历史和 pin 均安全 | COS 冷对象、FDB 元数据和引用 |

因此：

- **DO JS 是否关闭，看请求活动，不看 CPU/RSS，也不看 SQLite 是否已经冷降。**
- **关闭 isolate 不删除 Object，也不删除它的持久状态。**
- **写入 COS 和清理 FDB 热页是两个阶段。**拥有 COS 副本不代表已经释放 FDB 热数据。
- 下一次请求可以把同一个 Object 唤醒到任意合格 Host；新的 execution generation 必须严格大于
  旧 generation，任何时刻只允许一个 generation 写 SQLite。

这里关闭的是某个 Object 的 isolate/执行上下文，不是删除 Worker JS。一个 immutable Worker
Version 被大量 Object 共享，代码制品和 Host 代码缓存有自己的生命周期；不能按 Object 数重复
上传代码，也不应在每次 Object 休眠时删除共享代码。

## 2. 计算侧：何时判定 JS 不活跃

生产默认 `RIVET_WORKERD_IDLE_SLEEP_MS=30000`。每个已准入 Actor 最多只有一个可取消的
idle timer，判定过程如下：

1. Actor 首次启动后开始计时。
2. 每个 HTTP 请求开始前，Host 取消旧 timer，并递增本地 `activity_epoch`。
3. 请求结束后，Host 为这一轮 epoch 设置 30 秒 timer。请求成功与否都算一次活动。
4. timer 到期时必须同时满足：
   - Actor ID 和 Pegboard generation 仍与 timer 相同；
   - `activity_epoch` 没有被新请求推进；
   - Envoy 观察到该 generation 的活动 HTTP 请求数为 0；
   - Actor 仍在本 Host 的 active registry 中。
5. Host 只向 Pegboard 发送带 generation 的 sleep intent。若 Actor 仍然空闲但 intent 尚未被处理，
   每 5 秒重试；Host 不自行释放 slot，也不自行创建下一任 owner。

只要一个 Agent 请求仍在执行，例如正在等待模型或工具调用，活动请求计数就不是 0，不会因
30 秒 timer 被休眠。相反，请求已经完成后遗留的普通 JavaScript promise、内存 timer 或未持久化
后台状态，不构成平台驻留权；当前产品的工作单元是请求，不是无限期后台进程。

`RIVET_WORKERD_IDLE_SLEEP_MS=0` 只用于显式关闭自动休眠的调试或受控实验。生产不得用它承载
大量长期 Actor，否则逻辑 Object 基数会直接转化为 placement slot 和 isolate 基数。

### 并发请求

并发请求不会让旧 timer 错误关闭 Actor：

- 每次请求开始都会推进 epoch，旧 epoch 的 timer 失效；
- timer 到期后还会读取 Envoy 的活动请求计数；
- fetch 持有 Actor 读锁，stop、代码替换和 isolate eviction 持有同一 Actor 的写锁；
- 已经被接受的 in-flight 请求完成前，stop 无法越过写锁销毁 isolate。

这意味着空闲判定是“最近启动的有效活动 epoch 已到期 + 判定时没有活动请求”，不是粗略的
wall-clock `last_seen`。有一个值得明确的性能语义：若较早开始的并发请求比最新 epoch 多运行了
30 秒以上，timer 会每 5 秒等待它结束；它结束后的下一次检查即可休眠，不会再额外驻留完整
30 秒。这不影响请求正确性，但会减少长短请求乱序结束后的 warm window。

## 3. 休眠的线性化与 slot 释放

Pegboard 是 placement lease 的唯一所有者。权威身份是：

```text
(actor_id, generation, envoy_key)
```

Host 的 active registry、workerd isolate、SQLite bridge 和 Depot binding 都只是这一精确
generation 的下级 capability。

Pegboard 接受 sleep intent 后，在 FDB 中删除 `ConnectableKey` 并写入 sleep timestamp；这是
Actor 对新请求不再可连接的线性化点。随后 Pegboard 向原 Envoy generation 发 Stop 命令。
Host 排空请求、驱逐 isolate、注销 SQLite capability 后，Pegboard 才 deallocate placement 并
递减 slot 计数。

若新请求在 Stop 过程中到达，Pegboard 设置 `rewake_after_stop`。旧 generation 仍必须完整停止，
然后才分配新 generation；不能取消一半 teardown 后继续复用旧 owner。

以下故障都只能导致 Actor 多驻留一会儿，不能产生双写者：

- sleep intent 丢失或重复；
- Host 在 Stop 中失败；
- 新请求与 sleep intent 并发；
- Envoy/Engine 重启后命令重放。

Depot commit 会把期望 writer generation 与 Pegboard 的 `GenerationKey` 串行化比较。旧 isolate
即使没有及时退出，也不能在新 generation 接管后提交 SQLite 写入。

## 4. 存储侧：冷副本与 cold-only

存储冷降不使用 30 秒 Actor idle timer，而由每个数据库分支的 Depot manager 独立推进。
Actor 进入 Sleeping 时不得发送 force-compaction 信号：SQLite commit 在返回前已经持久化，
休眠只释放计算 placement；若把 30 秒 idle 事件直接映射成 hot/cold/reclaim，会让同一时刻
休眠的大量 Agent 形成冷降惊群，并反压前台创建。Depot 的 dirty marker、周期 planner 和
有界 cold queue 才是冷降调度真值。

### 4.1 Cold-backed：先发布可恢复副本

新的 durable mutation 推进 manager planning clock。默认在写活动安静约 2 分钟后，cold
compaction 把符合条件的 shard 发布为 immutable COS object，并在 FDB 原子安装带内容哈希、
txid 和 lifecycle generation 的 cold reference。

冷对象单对象硬上限为 4 MiB；具体对象可以更小。只有 PUT 成功且 FDB publication proof 安装
成功后，该 cold reference 才可用于恢复。发布失败时保留 FDB 权威热数据并重试，不能为了
“尽快冷降”先删除热页。

这一步可以在 Actor 仍活跃时发生。它建立可恢复副本，但不立即降低 FDB 热页占用。

### 4.2 Cold-only：再清理 FDB 热缓存

默认 `ShardCachePolicy.retention_ms` 为 7 天。数据库读写会更新按分钟分桶的最近访问时间；只要
分支仍在 retention 窗口内，reclaim 不选择它的热 shard。

过了 retention 后，生产默认的 reclaim planner 每 10 分钟被
`RIVET_DEPOT_RECLAIM_INTERVAL_MS=600000` 唤醒一次。每个候选还必须证明：

- 对应或更新的 immutable cold ref 已发布，内容哈希正确；
- cold ref 属于同一个 database branch 和 lifecycle generation；
- 当前 Actor/VFS 不再持有阻止回收的本地 pin；
- PITR、restore point、fork/snapshot 和历史读取没有引用该版本；
- reclaim watermark、transaction key/value budget 和 bounded batch 限制均满足。

全部满足后，planner 才在有界 FDB transaction 中删除热 shard/history。由此生产中从“最后一次
数据库访问”到 cold-only 的正常下界约为 7 天，实际完成时间还包括最多一个 10 分钟扫描周期和
积压排队时间。

资格测试会给精确测试数据库临时设置 `retention_ms=1`，并显式请求 bounded force reclaim。
这只是在几分钟内证明同一状态机，**不是生产默认策略**。force reclaim 只立即唤醒正常 planner，
不能绕过 cold publication、hash、pin、历史或 FDB transaction budget。

### 4.3 Cold object GC 不是冷降

一个仍然属于 live Object 的 cold object 不会因为 Actor 休眠而删除。只有数据库/版本已经 retire，
且 `ColdGcPolicy` 的 grace period、引用计数、backup fence 和 exact-key delete outbox 都允许时，
物理 GC 才能删除 COS 对象。休眠、cold-only 与用户删除是三个不同协议。

## 5. 再次请求如何唤醒

睡眠后的请求沿用稳定的 Object/Actor ID：

1. Registry/Workers API 解析 ObjectRef，而不是复用某个旧 Host 地址。
2. Pegboard 看到 Actor sleeping 后重新 placement。
3. 新 Host 取得更高 generation，准备对应的 immutable Worker Version/Deployment。
4. SQLite bridge 只为该 generation 注册 storage capability。
5. 读取优先命中本地 materialized cache/FDB hot cache；cold-only 时由 COS cold object 恢复，并叠加
   FDB 中更新的 hot tail。
6. 第一条请求完成后再次进入相同的 30 秒 idle 流程。

所以“休眠后可以重调度”是当前语义；Actor 不固定在原 Pod 或 Node。稳定的是 Object ID 和持久
数据，不是计算位置。

## 6. 当前暂不具备的保活语义

当前 bundled workerd 路径尚未启用：

- WebSocket bridge 与 WebSocket hibernation；
- Durable Object alarm-index recovery；
- queues 和 scheduled events；
- 请求完成后无限期运行的 durable background task。

`can_hibernate()` 当前明确返回 `false`。因此第一版 Agent 应把每次模型/工具执行包含在一个有界
请求中；跨请求的记忆写入 SQLite。未来加入 alarm、WebSocket 或队列时，它们必须成为显式、
持久的 wake source，而不能通过偷偷延长 idle timer 实现。

## 7. 运营参数与调优原则

| 参数/策略 | 生产默认 | 作用 | 调整风险 |
|---|---:|---|---|
| `RIVET_WORKERD_IDLE_SLEEP_MS` | 30,000 ms | 释放 isolate、binding 和 placement slot | 太短增加冷启动/抖动；太长降低密度 |
| cold compaction cadence | 约 2 分钟写静默 | 建立 COS 可恢复副本 | 太激进增加 PUT；太慢扩大 FDB write debt |
| `ShardCachePolicy.retention_ms` | 7 天 | 保留最近访问数据库的 FDB 热缓存 | 太短增加 COS GET/冷读；太长增加 FDB 成本 |
| `RIVET_DEPOT_RECLAIM_INTERVAL_MS` | 600,000 ms | 扫描已具备回收资格的热页 | 只影响扫描及时性，不改变安全资格 |
| access touch 粒度 | 60 秒 | 限制最近访问索引写放大 | 会让 cold-only 时间具有约一分钟粒度 |

不要把 idle timeout 用作租户 quota，也不要因单个 Host RSS 高就跳过 Pegboard Stop 协议直接杀
isolate。容量保护使用 Host active-Actor 上限、request admission、placement slot、drain 和节点
扩容；生命周期策略只决定已经无请求的 Actor 何时释放资源。

生产调优应观察至少以下 Cell 级指标，禁止用 Actor/Object ID 作为 Prometheus label：

- active、sleep-intent、sleeping Actor 数与每分钟 wake/sleep 次数；
- idle-to-slot-release 延迟，以及 `rewake_after_stop` 比率；
- Host isolate/VFS binding 数、请求 in-flight/queue 和拒绝数；
- FDB hot bytes、cold-backed bytes、cold-only bytes；
- cold publish/reclaim backlog age、COS PUT/GET 与实际对象填充率；
- cold wake p50/p95/p99 和 30 秒内再次唤醒率。

若“休眠后 30 秒内再次唤醒率”持续很高，应延长计算 idle timeout；若 FDB hot bytes 成本过高而
7 天内复访率很低，应通过正式 `ShardCachePolicy` 缩短存储 retention。两者必须分别调整，不能
用一个参数同时改变计算和存储行为。

## 8. 必须长期保留的资格测试

1. 请求完成后不调用显式 sleep，Actor 自动休眠并释放精确 slot/binding。
2. timer 到期同时到达新请求，旧 generation 完整停止，新 generation 单活接管。
3. 多个并发请求乱序完成，Actor 不在任何请求 in-flight 时被停止。
4. Host/Engine 在 sleep intent、Stop、deallocate 各边界崩溃，命令重放不双减 slot、不双写。
5. Counter `1 -> sleep -> wake -> 2`，Object ID 不变、generation 增长、SQLite 状态不丢。
6. natural cold：不使用 checkpoint/force reclaim，验证 cold publish 与 retention 后回收。
7. forced qualification：临时 `retention_ms=1`，证明 force 仍不能越过 pin 和 publication proof。
8. cold-only 后删除本地缓存并唤醒，验证 COS 内容哈希、FDB hot tail 叠加和 cold-read SLO。
9. 大量 Actor 同时 idle/cold 时，sleep、cold publish 和 reclaim 均有界且公平。

## 9. 实现映射

- Host idle epoch、timer 和 sleep intent：`runtimes/workerd/host/src/lib.rs`
- 生产/快速 profile 参数：`infra/cells/deploy/tencent/fleet/runtime/install.sh`
- Pegboard sleep、rewake 和 slot deallocation：
  `engine/packages/pegboard/src/workflows/actor2/{mod.rs,runtime.rs}`
- Depot cold/reclaim cadence：`engine/packages/depot/src/conveyer/constants.rs`、
  `engine/packages/depot/src/workflows/db_manager.rs`
- shard cache policy 与安全回收：`engine/packages/depot/src/conveyer/types/policy.rs`、
  `engine/packages/depot/src/compaction/shared.rs`
- 自动休眠端到端门禁：`infra/cells/deploy/local/mesh/workerd-auto-sleep-e2e/`
