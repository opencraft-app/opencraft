# Actor fleet controller: Set 化运营设计

状态：实现中
日期：2026-08-16
控制器：`fleet.actor.dev/rivet-fdb-cos`

## 目标

`ShardPool` 是一组可独立扩缩、隔离故障并安全退役的 `RivetCell`。一个 Cell 仍然是一个
独占 FDB 集群、一个 COS policy domain 和一组 runtime host；扩容单位不是 Pod、FDB process
或 Actor。FDB substrate 可以是历史的原生 CVM，也可以是官方 FoundationDB Kubernetes
Operator 管理的专用 TKE Worker + CBS，但同一个 Cell 只能选择一种。

第一版控制器负责集合收敛，不假装自己已经是云资源 provisioner：

- 采纳带 `fleet.actor.dev/pool=<ShardPool name>` 标签的现有 Cell；
- 当 Cell 数少于 `minCells`，或成员报告 50% admission 水位已关闭时，创建有界的
  `RivetCellClaim`；
- 从每 Cell 唯一的 `RivetCellReport` 推导 placement、容量和退役状态；
- 维护 Pool 的成员、候选 Cell、缺口和 Conditions；
- 用 finalizer 阻止没有不可变退役证明的 Cell CR 被删除；
- 不自动删除 Claim、Cell、CVM、CBS、FDB 或 COS。缩容先是业务 drain 和显式销毁计划，
  不是 Kubernetes garbage collection。

这里没有 per-Actor Kubernetes 对象。Actor placement 的 CAS reservation 继续属于 FDB 中的
durable placement directory；Report 只携带每 Cell 的聚合计数和风险等级，避免把高频 Actor
事务放进 etcd。

## 资源关系

```text
ShardPool (期望 Set、min/max、placement policy)
  |-- RivetCellClaim[]  controller 创建；人工审核 Terraform，自动绑定其输出
  |-- RivetCell[]       真实故障域，按 pool label 采纳
        |-- FoundationDBCluster (仅 Kubernetes substrate；精确 UID 绑定)
        `-- RivetCellReport (同 namespace、同名、一 Cell 一个)
```

`RivetCellClaim` 是扩容意图，不是“Cell 已存在”。Claim 计入 pending capacity，但绝不计入
ready capacity。云 provisioner 完成 FDB/COS/runtime 创建和资格验证后，才创建/绑定
`RivetCell`，并持续提交 Report。人工边界只到审核并执行该 Claim 的 Terraform plan；随后
inventory 发布、Argo 安装、资格验证、Report 发布以及 placement admission 必须自动完成。
不得要求运营人员手工 patch `status`、reporter 环境或一个独立的 `accepting` 开关。

Kubernetes substrate 中，Fleet FDB provider 只拥有 `FoundationDBCluster.spec`、Cell binding
label 和每 Cell 的 PDB（9 Pod profile 固定整数 `minAvailable: 8`）；官方 FDB Operator 独占
status、Pods、PVCs、ConfigMaps、进程替换和滚动操作。两者不写
同一字段。`RivetCell` 不对 `FoundationDBCluster` 设置 ownerReference，防止控制面记录删除级联
删除数据库。首次创建后 provider 把精确 CR UID 写回 `clusterRef.uid`；该 UID 丢失或变化时
fail closed，不得以同名新建数据库冒充旧 Cell。
Operator status 首次给出 connection string 后，provider 还会绑定由 CR UID 和 FDB database
name（冒号前的稳定部分）计算的 `clusterIdentityHash`；coordinator generation/IP 变化不会改变该
identity，而同一 CR 下数据库名变化会 fail closed。

## 信任边界

控制器不会根据以下信号宣布 Ready：

- `RivetCell` 对象存在；
- `spec.desiredState: Ready`；
- 六个 instance ID 已填写；
- Pod/进程处于 Running；
- 运营人员手工 patch status。

Ready 必须同时满足：

1. Report 的 `cellRef.uid`、`observedCellGeneration` 与当前 Cell 一致；
2. Report 未超过控制器的 freshness deadline；
3. profile digest、FDB cluster identity 与 Cell/Class 声明一致；
4. 原生资格 Cell 的 `2/2/2` 或 Operator 生产 Cell 的 `3/3/3` 拓扑符合 profile；
5. Kubernetes substrate 的 Operator generation、process group、运行版本和 full replication
   全部收敛；这不能替代独立 Report；
6. FDB available/healthy、runtime/backup/credentials 合格且没有 correctness violation；
7. qualification receipt 是 `sha256` 固定的不可变引用；
8. 风险等级为 `Normal`，且 desired state 明确为 `Ready`。

生产 RBAC 必须只允许 Cell Agent/验收发布器写 Report；业务 tenant 和普通 controller 不能写。

## 状态机

```text
Provisioning -> Qualifying -> Ready -> Draining -> Retired
                     |          |         |
                     +------> Frozen <----+
                                |
                              Failed
```

- `desiredState` 是运营意图，`status.phase` 是控制器观察结果；两者不能互相代替。
- Report 缺失、过期或引用不匹配时 fail closed：`readyForPlacement=false`。
- correctness violation 直接进入 `Failed`，覆盖容量百分比。
- `Draining`、`Frozen`、`Retired` 永远关闭新 placement。
- `Retired` 只有完整 retirement proof 才能出现。

## Set 收敛

每次 Pool reconcile 都按标签列出 Cells 和 Claims，忽略 class/region 不匹配的对象并报告
`MembersValid=False`。期望集合大小为：

1. 至少 `minCells`；
2. 若有效成员到达 `AdmissionClosed/Protect/Emergency`，且容量评估器发布了一个未处理的
   单调 `scaleOutEpoch`，再请求一个 Cell；
3. 永不超过 `maxCells`；
4. 已 Bound 的 Claim 若已有同 `claimRef` Cell，不重复计数。

缺口由 controller 逐个创建 Claim，并给每轮 reconcile 设置创建上限，防止错误配置瞬间制造
数百个云资源请求。Claim 没有 Pool ownerReference；删除 Pool 不会级联触发 provider 销毁。
容量 Claim 固定记录 `(Cell UID, scaleOutEpoch)`；同一 epoch 无论 Report 刷新、controller 重启
或新 Cell 绑定都只兑现一次。旧热 Cell 在 `NewActorsOnly` 策略下不会因为新增 Cell 自动降载，
因此绝不能把每次看到 `AdmissionClosed` 都解释成新的扩容事件。真实容量评估器只有在确认还需
下一单位容量时才递增 epoch。

Provider 标记为 `Failed` 的 Claim 也占用一次已尝试的扩容槽，并令 `ClaimsHealthy=False`。
controller 不会在 provider 持续失败时无限创建新 Claim；运营人员必须先修复 provider，再以
新的容量 epoch 或明确的新 Claim 重试。

Pool status 提供：总/ready/pending/draining Cell 数、pending Claims、placement/pending reservation
聚合数、期望 Cell 数、缺口、可 admission 的确定性排序候选以及 Conditions。placement service
仍必须在 FDB 中做 CAS reservation；status 不是事务授权源。

## 退役与删除

每个 Cell 都带 `fleet.actor.dev/retirement-protection` finalizer。只有 desired state 为 `Retired`，
且新鲜 Report 证明下列全部条件时才移除：

- exact placement、pending reservation、active writer、in-flight commit 为零；
- migration、compaction、GC、reconciliation backlog 为零；
- cold/backup exact-key 可达；
- old generation 已拒写；
- rollback retention 已到期；
- FDB、CBS、COS policy 和凭据已枚举；
- retirement receipt 的 generation 与 Cell retirement generation 一致并带 `sha256`。

移除 finalizer 只允许删除 Kubernetes 控制面记录，不自动删除任何云资源。真正销毁由独立、
显式确认的 provider 工作流执行，并保留 receipt。

## 高可用和故障行为

- controller-runtime manager 使用 Lease leader election，多副本只有 leader 写状态/Claim；
- watch 可限制到一个 namespace，云上试验不会触碰 `actor-fleet-system`；
- API conflict、短暂读失败交给 workqueue 指数退避；周期 resync 处理漏事件和 Report 过期；
- 所有派生状态写 `observedGeneration` 和标准 Conditions；相同输入得到相同输出；
- Claim 创建、finalizer 和 status update 必须幂等。

## 分阶段上线

1. 单元测试纯状态机和退役证明；
2. OrbStack 安装 CRD，双副本 controller 验证 Claim/Report/leader failover；
3. 北京 TKE 在独立 namespace、限定 watch scope 做同一试验；
4. 在兼容 Kubernetes 版本的 TKE 隔离 namespace 安装固定 digest 的官方 FDB Operator；
5. 用九台专用 Worker、retained CBS 和 `three_data_hall` 进行 Operator Cell 资格测试；官方
   Operator 对该冗余模式固定选择九个 coordinator，并要求九个不同 hostname 故障域；
6. 接入真实 Cell Agent，只读采集 FDB/runtime/COS/FDB placement 聚合证明；
7. 接入 TKE Node Pool/COS provider claim fulfillment；默认仍不允许自动销毁或自动缩容；
8. 通过故障注入和容量 gate 后，placement service 才消费 admission candidates。

## 明确不做

- 不通过增加单个共享 FDB 集群节点来假装 Cell 水平扩容；
- 不让 Fleet provider 和官方 FDB Operator 同时拥有同一个 spec/status 字段；
- 不在 K8s status 中实现 CAS reservation；
- 不在 Report 过期时沿用最后一次 Ready；
- 不因删除 CR 自动删除云盘、COS bucket 或 FDB 集群；
- 不在这版 controller 内实现跨 region/global Actor route。
