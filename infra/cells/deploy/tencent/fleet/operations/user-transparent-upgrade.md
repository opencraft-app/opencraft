# 用户无感升级与演进契约

本契约验证的是用户可见的 Workers `/v1` 与 Durable Object 行为，不以内部
Actor API 作为成功条件。Kubernetes rollout、Argo CD Sync 和 Pod Ready 都只是
过程证据；只有持续公共请求与持久状态检查通过，才能称为用户无感。

## 用户可见不变量

1. `Worker`、`Version`、`Deployment` 与 `ObjectRef` 的公共标识在平台升级中保持不变。
2. 已成功返回的 Durable Object 状态不丢失；同一对象在任一时刻最多有一个可提交写入的 generation。
3. release 期间公共 `/v1/.../fetch` 不返回平台 5xx，不出现连续不可用窗口；读取与一次明确写入必须在 3 秒请求期限内完成。
4. 平台不会替用户自动重放非幂等 `fetch()`。连接在响应前断开时结果仍可能是“已执行但调用者未知”；业务重试需要幂等 key，这是 API 语义而不是 rollout 可以消除的问题。
5. HPA、Host drain 与 MachineSet 在 release 期间仍拥有动态容量。发布不得重置副本数、取消 drain、继承旧 Pod UID，或把共享依赖故障归因于 Node。
6. 新旧二进制并存时必须读懂同一份线上数据和协议。任何不满足向后/向前兼容的变更必须采用 expand → migrate → contract，不能一次 rollout 完成。
7. release 与独立 Host scale-in controller 不得同时选择或删除 ordinal。release 若撞上已有 hold 或正在收敛的 drain，最多等待 15 分钟；只在 drain 状态为 `Idle` 时，以 StatefulSet UID 和 resourceVersion CAS 获取带唯一 ID 的持久 hold。controller 观察到合法 hold 后暂停缩容，但 HPA 扩容继续。超时、malformed、外来 UID 或遗留 hold 都 fail closed，禁止自动抢锁或按时间猜测 owner 已死。

## 发布类型与动作所有者

| 发布对象 | 动作所有者 | 无感策略 |
| --- | --- | --- |
| Workers API / Registry | Code Plane release workflow | 三副本滚动，CAS Deployment 状态；旧副本必须可读取新 schema |
| Engine | runtime release workflow | 三可用区、PDB `minAvailable=2`、一次只替换一副本；NATS/FDB 保持共享真值 |
| NATS | 独立依赖发布 workflow | 常规 runtime release 只读取并重申相同组件身份，不得替换 NATS Pod；只有 NATS 镜像或自身配置变化才能进入独立 lame-duck 滚动门禁 |
| workerd Host | runtime release workflow + Host drain | 先把目标 Host placement capacity 置零，等待 in-flight/queue 归零，再替换精确 Pod UID；对象在其他 Host 以更高 generation 唤醒 |
| runtime capacity / Cell reporter | control release workflow | 不拥有 Host replicas、MachineSet replicas、Node admission/drain 字段 |
| FDB/COS 数据格式 | 独立 migration workflow | 双读/双写或版本化 immutable object；完成备份、恢复和回滚期限后才 contract |
| CRD/RBAC/Service/PDB/NetworkPolicy | C 集群真实 Argo CD | 先 dry-run 与只读 drift；逐类证明后才开启 self-heal，默认不 prune |

普通 StatefulSet `RollingUpdate` 只遵守 Pod 顺序与 Ready，不理解 Actor 是否已经
排空。Host Pod 的 `workerd-host` 与 `workerd` 容器因此使用相同的 preStop 协议：先
通过管理端口发布 placement capacity=0，确认 metadata 已发送，再等待 active Actor、
bridge、in-flight 与 queue 全部精确归零。任一步无法证明时，hook 保持阻塞直到 620 秒
安全上限，由 rollout 超时停止后续 ordinal；绝不能提前退出并杀死 V8。运行时安装器
在两个容器的 hook 之间使用 Pod-scoped `emptyDir` 屏障：原子选出唯一 drain leader，
leader 只有在上述条件全部成立后才发布 `quiescent` marker，另一个 hook 不重复访问
可能已退出的 Host 管理端口。Kubelet 不保证普通容器 preStop 的串行顺序，因此没有这个
屏障时，一个 hook 返回后 Host 可先收到 TERM，使另一个 hook 安全地死等到 grace 上限。
安装器
还必须按 base → Engine → NATS → pool init → Host → reporter 分阶段收敛，字段 ownership
handoff 也不得越过对应阶段。Host 阶段先把 StatefulSet 置为 `OnDelete`，逐一发布
placement fence、证明精确 quiescence，再用 Kubernetes DeleteOptions UID precondition
删除同一个 Pod；替代 UID 在新 revision Ready 后才处理下一 ordinal，全部完成后恢复
`RollingUpdate`。这既避免 Engine 与 Host 两个故障域同时滚动，也覆盖尚无 preStop 的
首个旧版本。存量 Cell 必须先收敛支持 lame-duck 主动重连的新 Engine，再滚动 NATS；
新建 Cell 则因初次连接依赖先收敛 NATS。NATS 以原生 lame-duck 排空，并且新 Pod 只有
形成完整三成员 route mesh 后才 Ready。失败回滚按 NATS → Engine → Host，使 NATS
替换始终发生在理解主动迁移协议的 Engine 下。这些机制通过云上公共流量门禁前，仍不能把
Host 或 NATS 升级标记为“用户无感”。

Engine 的 `preStop` 先创建本 Pod 的 draining marker，使 1 秒 readiness probe
立即失败；随后保留 30 秒让 EndpointSlice/kube-proxy 收敛，再向 PID 1 发送 SIGTERM
并等待已有的 Guard graceful shutdown 完成。仅做固定 sleep 是不安全的，因为
Kubernetes 从 EndpointSlice 移除 Pod 不会关闭既有 HTTP/1.1 keep-alive；因此 Workers
API 的非幂等 fetch 数据面禁止跨请求复用 Engine 连接。每个新请求建立到 Service 的新
连接，drain 窗口内旧 Engine 仍能完成已经选中它的请求，窗口结束后新连接只会命中 Ready
副本。云上 kube-proxy 仍可能在 EndpointSlice 收敛边缘把一次新 TCP 映射到刚停止监听的
Pod；Workers API 只在 `dial()` 返回 `ECONNREFUSED/EHOSTUNREACH/ENETUNREACH` 时有界
重试建连，因为此时 TCP 未建立、HTTP 请求零字节发送。连接建立后的 EOF/reset 绝不重试，
平台不会自动重放可能已执行的 POST。620 秒 termination grace 是异常失效上限，不是正常
等待时间。

2026-09-06 的北京门禁证明 10 秒不足：Engine 第二、第三个 Pod 交接分别产生约
3.16 秒和 6.36 秒的成功但超时读取，且尖峰与 terminating Engine 精确重合；Host
替换阶段没有同类尖峰。30 秒是当前经故障证据选择的最小生产 drain 窗口，必须继续由
公共流量门禁验证，不能把客户端自动重试或放宽 3 秒 SLO 当作修复。

## 每次发布的固定 SOP

### 1. 预检

- operation lock 必须空闲，autonomy verdict 为 `allow`，静态 release ledger 收敛。
- FDB available/full replication，连续备份 `Restorable: true`，cold writeback 无失控积压。
- 候选镜像使用远端 registry digest，在每个目标节点以 `Always` 拉取并运行固定 ABI probe。
- 记录旧 release ledger、所有 workload/Pod UID、动态 Host/Machine 副本数以及公共资源 ID。
- 先创建一个候选 Worker/Version/Object 执行真实 prepare/canary；不得用 readiness probe 替代。

### 2. 公共流量门禁

- 通过 Workers `/v1` 创建至少 32 个 Durable Objects，使其跨越所有当前 Host。
- 每个对象写入初始 Counter 值并读取确认；随后以至少 20 并发持续发只读 `fetch()`。
- 在流量持续期间执行正式 release，而不是直接 patch Deployment/StatefulSet。
- 北京固定入口为 `qualification/actor-bj-q01/user-transparent-upgrade.py`；它在同一
  进程中启动公共流量、执行 `release-runtime.sh`、按每个 workload 的 Pod-template
  身份核验 UID transition，并把 release 日志哈希和逐请求结果写入同一份资格
  receipt。模板发生变化的组件必须完成全量 UID replacement；模板不变的固定组件
  必须保留精确 UID 集合；HPA 管理的 Host 只允许增加或移除 ordinal，不允许同名
  ordinal 被偷偷替换。不得重启未变化组件来制造一次“完整 rollout”，也不得把两个
  独立命令的时间戳人工拼成一次门禁。
- 可信操作机只调用 `run-user-transparent-upgrade-via-tat.sh`，传入 registry 已确认的
  runtime/reporter digest 及 runtime source identity。该入口固定 builder、私有
  kubeconfig、q01 Cell、生产 profile、精确缩容身份和 receipt 路径；NATS、metrics
  sidecar 与 Registry URL 从 live workload 读取并要求仍符合 q01 合约。
- 若现有 autonomy block 只包含过期/失败资格 receipt 和健康的 ObserveOnly FDB
  bootstrap，入口只打开专用的 `ALLOW_EVIDENCE_RECOVERY`；它不接受普通 degrade，
  发布完成后仍必须重新生成 Bottomless、HA、扩缩容与 DR 证据才能恢复 autonomy。
- 门禁复用固定的 `q01-platform-upgrade-gate` Worker，因为公共 DELETE 按产品契约会
  拒绝任何声明过 Durable Object namespace 的 Worker；每次运行只创建唯一 Object
  ID 并精确删除它们，避免每次资格运行永久增加一个 Worker/Version inventory。
- 内部只读 registry lookup 可用于证明 generation 单写者，但不得替代或绕过公共请求。
- 记录每个请求起止、HTTP 状态和延迟，以及每次 Pod UID、Host readiness、HPA/MachineSet 副本变化。

### 3. 成功门槛

- 公共 API 请求失败数为 0；max < 3 秒，p99 不劣于发布前基线的门限。
- 全程每个对象最多一个同时活跃且可写的 generation；Host/SQLite registry 一致。
- 常规 runtime release 前后 NATS revision 和三个 Pod UID 必须完全相同；否则即使请求最终恢复也判失败。
- Engine、Host、NATS、runtime-capacity 与 Cell reporter 的命名容器镜像必须精确等于
  本次发布目标 digest。每个组件是否应滚动由发布前后 API Server 中的 Pod-template
  SHA-256 决定，而不是由 release 类型或测试脚本预设；变更组件不得残留旧 UID，未
  变更组件不得出现无解释的 replacement。
- rollout 后仍使用相同 ObjectRef，Counter 不回退；再写一次必须得到精确的下一值。
- runtime Host 的动态副本数没有被 release 改回 bootstrap 3；若 HPA 同时扩容，扩容优先。
- HPA 在门禁负载下提高 Host desired count 时，门禁单独等待最多 15 分钟让 Pending Pod、
  MachineSet 与 TKE Node 收敛，并记录 desired/Ready 的每次变化；云节点供应时间不计入单请求
  3 秒 SLO，但超时或最终少一个 Ready Host 仍判失败。不得以“发布前后副本数不同”为失败，
  因为该字段属于 HPA/Host drain，不属于 release。
- 所有 Ready Pod 的 `imageID`、workload digest、source identity 与新 ledger/外部 receipt 一致。
- Prometheus target、静态 drift、容量、cold tier、FDB 与 backup 告警回到稳态。
- 新 release 收敛后，旧资格的 `QUALIFICATION_RELEASE_DIGEST` 必须与新的
  `RELEASE_DIGEST` 不匹配，因此新 placement 保持关闭；已有 Object 流量继续运行。
  只有 Bottomless、Engine HA、Agent 到达率/FDB 扩容、DR 和本次无感升级证据共同生成
  新的严格 autonomy `allow` 收据后，资格发布者才能把该收据绑定的 runtime digest 写入
  `QUALIFICATION_RELEASE_DIGEST` 并重新开放 placement。不得从目标镜像参数自行推导这个值。
  正式入口是 `operations/publish-qualified-release.sh`；直接 `kubectl set env` 或直接修改
  `RivetCell.spec.desiredState` 不属于受支持的上线流程。

### 4. 失败与回滚

- 任一请求/状态/generation 门禁失败立即停止推进下一 Pod；保留现状与完整 receipt。
- rollback 必须走同一串行 workflow，并保留 HPA/Host drain/MachineSet 的动态字段。
- 若发布本身已经收敛、但公共流量门禁随后失败，autonomy 会立即关闭普通发布。此时
  `run-user-transparent-upgrade-via-tat.sh` 的第五个参数必须是该次失败 receipt；入口只在
  receipt 证明 release 已完成、存在公共失败、cleanup 完整、目标 digest 精确等于发布前
  Engine/Host，且 live digest 精确等于失败候选时，才为这一轮设置 degrade recovery。
  它随后进入专用 rollback workflow：先用保留的全部 Object 重现候选错误，在回滚期间持续
  发送公共 `/v1` read，旧版本收敛后使用相同 ObjectRef 验证状态从 1 精确推进到 2。
  回滚失败时不得清理这些 Object；仅在完整通过独立 verifier 后删除。它不能指定任意旧镜像，
  也不能作为普通发布逃生口。
- 若候选已写入旧版本不认识的数据，禁止二进制回滚；进入 forward-fix 或先执行已验证的数据降级流程。
- 回滚后重复相同公共对象检查，并确认 release ledger 精确回到旧版本。

## 演进规则

- Gasoline 工作流：activity/signal 的调用顺序、分支和循环调度同样是持久化协议。
- Retention/回收周期变更：Engine 重启不会改写已经持久化的 sleep deadline。发布事务
  完整通过后，必须运行 `kick-gasoline-pruner.sh CELL NAMESPACE KUBECONFIG`。它只通过
  null-tag 二级索引读取最多两个条目，要求恰好一个 sleeping `gasoline_pruner`，按 exact
  workflow ID wake，并证明下一次 deadline 已收敛到当前 interval；禁止用全量 `wf list`
  发现 pruner。缩短 retention 是不可逆的数据策略变更，不能混入可自动回滚的普通镜像发布。
  例如把 Depot 的定时回收改为“成功一批立即继续下一批”，即使不改 FDB key 和
  BARE 字段，也可能改变历史重放路径。不能仅凭新建工作流测试通过就发布。
  必须保存旧版本在等待、收到完成信号、提交 activity 后三个边界的历史，验证新版本
  恢复；还要验证新版本推进后的历史能否由指定回滚镜像恢复。Gasoline 的
  `check_version()` 可区分历史路径，但使用它本身不是双向兼容证明。
  若回滚镜像不能读取新路径，先发布只增加读取能力、不启用新调度的桥接版本，
  全部副本收敛后再启用新行为；否则该变更只允许已验证的 forward-fix，禁止自动回退。
- 公共 API：先增加可选字段，所有副本升级后再要求新字段；至少跨一个发布窗口接受旧客户端。
- FDB tuple/key：keyspace 带 schema 版本；迁移有 cursor、幂等 operation ID 和可恢复进度，禁止无边界全量事务。
- COS object：immutable、内容寻址或 revision 寻址；新 reader 先兼容旧对象，后台迁移后才退休旧格式。
- Durable Object code rollout 与平台 rollout 分离。用户 Deployment 的对象版本分配不能因平台 Pod replacement 改变。
- CRD conversion：在删除旧 served/storage version 前，必须完成存量对象重写、备份恢复和 downgrade 禁止门禁。

## Argo CD Hook 接口

C/管理集群中的真实 Argo CD 负责 Git desired state 和 Hook 生命周期，不再实现独立的
发布 reconciler。发布 Hook 调用 `run-user-transparent-upgrade-via-tat.sh` 时必须注入：

- `RIVET_UPGRADE_RUN_ID`：由 Git release intent 固定的 32 位小写十六进制身份；重试同一
  intent 不得产生新的逻辑发布身份。
- `RIVET_UPGRADE_LOCAL_RECEIPT`：Hook 工作目录下的 `/data/...json` 路径；包装器在远端
  成功或失败后都保存同一 run ID 的结果。生产批准命令只通过既有 `InvokeCommand` 返回
  compact receipt（完整 receipt 的 builder 路径、schema、verdict、大小与 SHA256），完整
  receipt 留在受保护 builder；Hook 不具备动态 `RunCommand` 下载权限。只有非生产的动态
  qualification 路径才通过 TAT 下载完整 receipt。

远端事务失败时 Hook 必须保持失败；下载失败也不能把远端成功显示为成功。Argo
`Synced/Healthy` 只表示编排状态，只有独立 verifier 接受该 receipt 才允许 PostSync
完成。语义候选失败后，SyncFail Hook 必须使用该失败 receipt 调用专用 rollback 入口，
不能通过重新同步旧 YAML 冒充对象连续性已经恢复。

## 当前资格状态

静态 release ledger、动态 replicas 排除、只读 drift audit、Cell 级指标以及公共
`/v1` 持续流量资格程序已经在代码中。北京早期真实门禁在 NATS 与 Host 滚动窗口
分别捕获了 `route_subscribe_timeout` 和 `fetch_failed`，因此正确判失败；上述排空、
lame-duck 与分阶段收敛是针对该证据的整改。2026-09-06 的第一轮 controller-only
发布完成 1,803 次零失败公共请求，且 Engine、Host、NATS UID 全部保持不变，但旧门禁
错误要求未变化组件也必须重启，因此 receipt 正确保留为失败历史。组件 template
identity 门禁整改后，正式运行 `edf963bba7c945028889cbaf1abf5dfb` 已通过：32 个公共
Object、1,820 次持续 `/v1` 请求零失败，max 0.1808 秒、p99 0.0992 秒；capacity/reporter
完成精确 UID replacement，未变化的 Engine/NATS 精确保留 UID，runtime 相同 ordinal
亦未被偷偷替换。其收据为
`/data/actor-qualification/receipts/actor-bj-q01-user-transparent-upgrade-0016b8ce153a4629ae9912463f899853.json`。

这证明当前 controller-only 正向升级路径，不等于所有未来平台版本已经天然无感。

2026-09-07 又完成了当前完整 runtime 候选的正向升级。receipt
`actor-bj-q01-user-transparent-upgrade-5d6c8544216c41589453d6d6a9b23a2b.json`
（SHA-256 `0ea0a678128cc61c46dbfefa6dd2dbe6ba79ae9068617a039535abecd2eacc77`）
记录了 32 个原 ObjectRef、7,116 次持续公共
`/v1` 请求零失败，p50/p99/max 为 0.0468/0.1576/1.5623 秒；Engine 与三个基础 Host
均完成 template 变化和全 UID replacement，capacity/reporter 也完成 replacement，未变化
的 NATS 精确保留原 UID 集合，升级后写入 max 0.1249 秒。它证明当前完整 runtime 的
正向无感升级，而不只是 controller-only 更新。

该次运行的 full receipt 本身没有 Argo Application、Hook Job/Pod UID、Git revision 或
TAT invocation provenance；本地只留有手工 wrapper 的 run-ID 文件。因此它不能被当作
“Argo 原生 desired-state 发布链已经云上通过”的证据。下一次 Argo 发布必须同时保存
Hook compact receipt、Application operation/history、Job UID 与 Pod ownerReference，并
核对它们引用同一 deterministic run ID。不能通过看到 Argo `Synced/Healthy` 或看到一份
同名 builder receipt 来补推这条因果链。

生产 placement 前仍须完成一个真实的语义失败候选：候选必须完整滚动且保持 Ready，
公共 `/v1` 门禁必须捕获用户错误，再由失败 receipt 仅授权回到 receipt 中的精确旧
runtime digest。授权器只接受 v2、公共 API、完整 Engine/Host candidate rollout、不可变
release log、未改变的用户 Worker Deployment 以及完整 Object cleanup；旧 v1 receipt
不再作为回滚权限。

2026-09-08 的当前发布链已经补齐 Argo 因果证据。运行
`5b7bf55937c17e304f2472b05139ecff` 在 32 个持久 Object 上执行 2,892 次公共 `/v1`
请求，零失败，p50/p99/max 为 0.0549/0.3148/0.8209 秒；发布证据包 SHA-256 为
`50468b344bfd5599f09e49c3db9c581946e3f234301f9f9d71a932215f5210e4`，包含同一
run ID 的 Git revision、Application、Hook Job/Pod、ownerReference、完整 receipt 与
provenance。当前 release 随后重新通过 Engine HA、100 Agent/s 的 3→7→3
负载扩缩容、自然冷降和物理恢复。最终 autonomy control 为 `allow`、score 100、无
failures/warnings；唯一资格发布器将 Cell 切到 `Ready`。在后续 Argo reconciliation
之后，control/runtime Application 仍为 `Synced/Healthy/Succeeded`，Cell 仍为
`Ready` 且 `readyForPlacement=true`。开闸后的单 Object 公共 `/v1` 冒烟完成创建、三次
持久增量、读取和删除，结果 SHA-256 为
`2ab4cd10a5a0ea207075d435b95fe82347387c17b25aeac9f07014f91befb94a`。

同日又完成了真实语义失败与回滚演练。故意错误的 runtime
`sha256:2b5940749ad20e6aa1983048a6d0235123acb85c8e927c69bb05eca07c17d54c`
只拒绝资格 Worker；Argo Sync 将它完整滚到 Engine/Host 后，公共 `/v1` 捕获
`fetch_failed` 并生成失败 receipt。随后 SyncFail 使用同一批 32 个 ObjectRef 精确恢复到
`sha256:48963636e53152411450013f423f75eba72d5a179089f9562f2bc3e356b41599`，
回滚期间完成 963 次公共请求，状态从 1 精确推进到 2，最终 receipt SHA-256 为
`14dd596754692eaf052d500bd672f853d133a6e97b4126af5fbea517db266162`。
新的稳定 Git intent 随后完成 1,532 次公共请求、零失败，并把 Argo 恢复为
`Synced/Healthy/Succeeded`；其 receipt SHA-256 为
`94e6e9c02f342316ea99860ce9bdc506a2216edc8b2f93c801ab1dba5d1918a6`。

该演练还修复了两个控制面缺口：语义候选构建现在原子保留与候选 manifest 绑定的不可变
source tree；定时 autonomy 审计与发布/回滚共享 Cell operation lock，避免在 Engine/Host
交错版本时记录瞬时 block。稳定审计为 allow 且 Cell 处于
`Provisioning/Qualifying` 时，同一受锁入口自动调用唯一资格发布器；异常 phase 或 CAS/发布
失败均保持关闭并使 systemd unit 硬失败。

这次结果证明的是“当前固定 release 的上线与后续可演进入口”已经闭环，不代表未来任意
变更自动获得资格。每个新 release 仍必须经过同一顺序：持续公共流量发布门禁 → 当前
release 的 HA/扩缩容/沉降/DR 证据 → autonomy control → 唯一资格发布器；Argo 只拥有
声明式组件，`RivetCell.spec.desiredState` 与动态 qualification 字段继续由资格状态机
拥有，不能重新纳入 Git self-heal。
