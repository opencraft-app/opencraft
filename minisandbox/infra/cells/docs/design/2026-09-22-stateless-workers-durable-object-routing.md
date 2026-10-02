# Stateless Workers、Durable Objects 与跨 Cell 内网寻址

状态：已接受；Phase 0–3 的核心代码路径已实现，生产编排与跨 Cell 资格验收进行中
日期：2026-09-22

## 结论

平台保留两种同时存在的用户模型：

1. 普通 Worker 是无稳定实例身份的 stateless fetch。请求可以在任意兼容执行节点上运行，
   isolate 只作为可复用缓存，不是用户可寻址资源；
2. Durable Object/持久 Agent 具有稳定的
   `(tenant, namespace, worker, class, object_id)` 身份、持久 SQLite 和单活 owner。现有直接
   `ObjectRef` API 继续保留，不因增加普通 Worker 而删除。

两者共享 Worker Version、Deployment、代码缓存和 workerd 运行时，但不共享调度单位：

```text
                        regional C
               +-------------------------+
external ----> | Workers API / Dispatcher|
               | Object Router (3+ pods) |
               | Registry / Fleet routes |
               +------------+------------+
                            / \
                 private CCN   private CCN
                          /       \
             runtime Cell A       runtime Cell B
          +------------------+  +------------------+
          | stateless pool   |  | stateless pool   |
          | durable pool     |  | durable pool     |
          | Engine/Gateway   |  | Engine/Gateway   |
          +------------------+  +------------------+
```

普通 Worker 可以通过 `env.COUNTER.get(id).fetch()` 惰性创建或调用 Durable Object。用户代码
得到的是受能力约束的 binding，不会得到 Registry、Cell、Actor ID、Engine 地址或内部 token。

这里不为每个 Object 分配 IP、Kubernetes Service 或 DNS。内网寻址只解析三层关系：

```text
logical object -> immutable Cell placement -> stable Cell gateway -> live Actor owner
```

第一阶段让 C 中现有三副本 Workers API 承担区域 Object Router，最大化复用已经存在的代码，
并避免让 Cell 内组件访问管理 Kubernetes API。路由实现必须抽成独立包，而不是继续嵌在 HTTP
handler 中；如果 Router 吞吐或 C 故障域将来成为限制，同一实现可以下沉到每个 execution Cell，
不改变对象身份、Registry schema 或用户 API。

## 目标与非目标

### 目标

- 提供接近 Cloudflare Workers 的普通 `fetch` 心智模型；
- 提供接近 Durable Objects 的命名、惰性创建、单活执行和持久 SQLite；
- 同一个 Worker Version 可以同时导出默认 fetch 和 Durable Object class；
- stateless Worker 节点能够安全调用位于本 Cell 或其他 Cell 的 Durable Object；
- 百万级休眠对象不要求百万级内存路由项、Pod、Service 或长连接；
- 万级活跃对象的稳定请求不把 Registry/FDB 放在每次请求热路径；
- Cell 扩容仍通过 Terraform 建设、Argo 收敛、资格门禁和人工 `accepting=true` 完成；
- 保留现有直接寻址的持久 Agent/Object API。

### 第一阶段不做

- 不实现跨地域透明 Object 调用；北京、上海、新加坡各自拥有独立 Router 和 Actor CCN；
- 不实现自动跨 Cell 数据迁移或故障夺主；Object placement 在删除前不可变；
- 不让 stateless Worker 直接访问目标 Cell 的 FDB、NATS、Pod IP 或 Service CIDR；
- 不为每个 Object 创建 Kubernetes 资源；
- 不把普通 Worker 伪装成 Rivet Actor；
- 不把 stateless isolate 的内存状态、Host 或复用时长定义为产品语义；
- 不透明重放已经可能进入用户代码的非幂等请求；
- 第一阶段不支持跨 Worker/跨 namespace Durable Object binding。

## 当前实现事实与差距

现有实现已经完成 Durable Object 路径以及 stateless Worker-to-Object 主链路的大部分正确性基础：

- Worker Registry v5 把 modules、compatibility、bindings 和 exports 纳入不可变 Version；
- `DurableObjectRecord` 持久化 Object 身份、不可变 `ObjectPlacement`、Actor ID、状态和
  generation；
- 首次 claim 和 Cell placement counter 在同一 FDB transaction 中提交；
- Workers API 的 `ensureActor()` 已实现 claim、placement、Actor create、activate 和有界
  TTL/LRU cache；
- `KubernetesPlacementResolver` 只从 fresh、admitted、UID 匹配的 Cell 中为新 Object 选址；
- Engine/Pegboard 负责 `actor_id -> live envoy/generation`，Depot commit 使用 generation fence；
- Host 已能验证不可变 Version、缓存代码、加载 Durable Object class 并在 sleep/wake 后恢复。
- Workers API serving route 已以 `cell_uid` 为主键，并同时校验 `pool_uid + cell_name + datacenter`；
- Workers API 已提供 token-gated 内部 Object Router fetch 边界，未配置独立 token 时默认关闭；
- 锁定的 workerd 已通过 WorkerLoader capability ABI 测试，证明可信 wrapper 可以持有 Router
  Fetcher/token，同时只向用户 isolate 暴露受限 Durable Object namespace。
- `/v1/workers/{worker}/dispatch` 已切换为真正的 stateless dispatch，不再为普通 fetch 创建
  `default` 持久 Actor；
- workerd Host 已有独立 stateless 模式；它复用 immutable Version/代码缓存，但不启动 Envoy Actor
  lifecycle、SQLite 或 Depot；
- immutable Version 中的 Durable Object binding 已由可信 wrapper 转换为 capability-bound namespace，
  用户代码不能获得 Router token、Actor ID、Cell 或 Engine 地址；
- Object Router 的有界 placement cache 与并发 miss single-flight 已抽为独立
  `internal/workersapi/objectrouter` 组件，通过 Backend 接口接入 Registry/Actor 收敛路径；服务仍以
  独立 internal listener 和独立 Cell token 暴露；
- Workers API 已暴露 bounded stateless dispatch、Object Router cache/route/Registry latency、
  in-flight 和 indeterminate result 指标，并已加入 Prometheus scrape annotation；本地三副本真实
  A/B 路由验收已确认指标能区分 public/peer Cell 与 cache hit/miss，且不含 Object、Actor 或 request
  ID label；
- C 集群 Hub Prometheus 已通过严格限定 namespace/Service 和采集上限的 ServiceMonitor 直接采集
  Workers API；recording/alert rules 与独立中文 Grafana 面板已纳入 bootstrap、Argo desired state 和
  本地一键资格门禁，本地真实验证覆盖三个健康 target、规则加载和 Grafana dashboard provisioning；
- C 集群 Workers API/Object Router 已定义 `3..30` HPA；通过独立 Prometheus Adapter 将 bounded
  per-Pod QPS 和 in-flight 指标提供给 autoscaling API，并以 CPU/RSS 作为安全信号。PDB、endpoint
  receipt、安装与替换门禁均把三副本解释为 HA 下限而不是固定上限；Argo 忽略 Deployment replica
  字段，避免 self-heal 与 HPA 争抢所有权。本地永久资格门禁已经使用 48 个真实 held fetch 证明
  `Workers API 3 -> HPA 4 -> 3`，请求 48/48 成功；扩缩容只由 per-Pod in-flight 自定义指标触发，
  门禁不直接修改 Deployment replica，并在退出时恢复完整生产 HPA spec；
- stateless executor 的 Kubernetes termination 已有永久 E2E：真实双 Pod 场景证明 readiness 先摘除、
  新连接转移到健康 peer、预算内在途响应完成；超过 45 秒 drain 预算时 timeout counter 增长，Pod 在
  60 秒 termination grace 内强退。响应头尚未发送时调用链返回 `502 indeterminate_result`；流式响应
  已经开始时则中止下游连接/HTTP stream，绝不把截断 body 干净结束为成功，也不透明重放；
- C Workers API 已能配置 A/B stateless executor，Cell 和 C 均已有独立私网 Service/CLB 安装与身份
  receipt；
- 首次上线的依赖环已拆成 receipt-bound 两阶段：Cell 先独立生成不可变、角色分离的 stateless
  capability，C 只同步其值而不取得所有权；`object-router-bootstrap` 先通过 Argo 启动内部 Router
  listener 且移除 stateless dispatch token，随后创建 Router 私网 endpoint，最后 A/B executor 和
  `CellServingRoute` 收敛后切换到 `serving`。旧 Hub Secret 仅作为一次性能力来源，必须证明既有
  Registry/Engine capability 完全不变；完整能力发布到内容寻址的 immutable Secret，Pod 模板和
  receipt 都绑定其名字与 UID。禁止删除并以同名重建 immutable Secret，因为 kubelet 的不可变对象
  缓存不以新 UID 强制失效，会让新 Pod 继续观察旧 key 集合；
- Registry 已拒绝同一渐进 Deployment 中不兼容的 Durable Object binding；Workers API 会在原子激活
  前 prepare 全部目标 Version；
- durable lifecycle command 已使用 FDB commit 后 ACK-of-ACK：Envoy 在收到 commit barrier 前保留
  checkpoint，断线重连后重发同一 ACK，服务端重复 range clear 保持幂等。每批 ACK 最多 `512`
  个 checkpoint，客户端逐 barrier 排空，服务端在任何 mutation 前拒绝超限或畸形批次；本地门禁
  已覆盖 barrier 丢失、旧 barrier 与新 checkpoint 竞争、重复 commit 和事务原子回滚。北京真实
  Cell 的 ACK/commit 边界断线 receipt 仍是正确性资格未完成项；
- stateless executor 已暴露并发、排队、过载、transport failure 和代码缓存指标，HPA、Prometheus
  抓取及中文 Grafana 面板已具备基础配置；同时已经提供 token-gated drain、独立 readiness/liveness、
  `Retry-After` 过载响应和 Pod `preStop` 摘流入口。
- 本地 A/B runtime 已使用独立 stateless 基线节点：节点先以 startup taint 进入隔离态，导入精确
  immutable runtime image 后才获得 `stateless-admitted=true` 并移除 startup taint；stateless executor
  通过 hard affinity 只落到该节点，Durable Host 仍留在 compute 节点。真实回归已再次通过跨 Cell
  Object 路由、sleep/wake、Pod replacement、readiness drain 和强制终止语义。
- 本地永久容量门禁已使用 60 个真实 held fetch 越过生产 `48 in-flight/Pod` HPA target 与 tolerance，
  证明 `metric -> HPA 1→2 -> Pending Pod -> immutable CapacityRequest -> startup-tainted k3d Node ->
  exact-image admission -> Pod Ready`；负载归零后同一门禁证明 HPA 2→1、正常 preStop drain、Node UID
  fencing、provider 重启恢复和空节点删除，最终严格回到一个基线 stateless Node。
- stateless dispatcher 不再把长期存在的 `CellServingRoute` 误作接流资格；它把 route 与
  `KubernetesPlacementResolver` 的 fresh admission lease 做 Cell/Pool/Datacenter/UID 精确交集。
  Cell 退出 admission 后普通 Worker fetch 立即停止选择该 Cell，而同一 serving route 继续为已有
  Durable Object 服务。单元门禁同时证明全部 admission 关闭时 fail closed，不能退回“所有可达 route”。
- 真实 TKE 的永久容量门禁已经代码化：以一个 immutable Version 发起有界流式负载，同时采样 A/B
  的 HPA、Deployment、Terraform inventory 中的动态 `np-*` Native NodePool、Pod 和 Node；receipt
  必须证明两 Cell 都经历
  `3 -> HPA 扩容 -> Pending Pod -> MachineSet/Node 扩容 -> 精确 runtime admission -> 3`。门禁只发布
  和删除临时 Worker，不修改副本、MachineSet、Node、taint 或 admission label。北京 A/B 实跑已
  通过：`2dcf466443e281d69e475ca0dffcc804` 在 2251 个请求全部成功的同时，两 Cell 均从
  3 个 stateless Pod 扩到 30，Native NodePool 从 3 个 Node 扩到 5 后安全缩回 3。不可变 receipt
  为 `stateless-autoscaling-2dcf466443e281d69e475ca0dffcc804/receipt.json`（SHA-256
  `3e52834935bdc5b82415a2bb3ec9720b0bee6cb9ae964858d0d3d865c517903a`）。
- 北京 C/A/B 的真实私网链路已完成最小 serving 验收：Registry、Workers API、Object Router 均为
  三副本，A/B 各有三副本 executor；同一不可变 Version 经公共 `/v1` 连续执行 101 次，101/101
  成功且两个 Cell 的 dispatch counter 均增长。上线时曾捕获一次确定性的组件版本偏斜：新 Workers
  API 依赖 deployment cursor，而旧 Registry 缺少游标字段和 watch endpoint，公共请求因而正确地
  fail closed。Registry 现已滚动升级且 UID/FDB/COS/私网 CLB 身份保持不变；`serving` Argo 安装器
  会在任何变更前验证精确 cursor schema，旧 Registry 不能再次与新 Workers API 组合上线。
- 北京真实 Worker-to-DO smoke 也已固化并通过：同一 stateless Worker 为 A/B 各选择一个确定性的
  rendezvous key，binding 调用与直接 `ObjectRef` 对同一对象连续观察 `1,2,3`，Registry 记录的
  immutable `cell_uid` 分别精确落到 A 和 B。门禁删除两个 Object，但复用一个稳定资格 Worker；它
  不绕过“存在终态 DO namespace inventory 时拒绝删除 Worker”的产品安全语义。
- 北京真实故障矩阵也已通过：B Object 进入持久 sleep 后替换一台 workerd Host，再由公共 stateless
  Worker 唤醒；随后依次替换中央 Workers API、B Engine/Gateway 和 A stateless executor 各一个 Pod。
  每一步都先恢复精确 Ready 下限再继续，A/B Counter 分别连续到 `1,2,3` 和 `1,2,3,4`，Actor ID 与
  immutable Cell UID 全程不变。不可变 receipt 为
  `stateless-do-fault-matrix-20260924.json`（SHA-256
  `270f13e1ef297f244436c1529975011fa067df053ac3d1f34116850db55c2c8c`）；两个 Object 已删除，稳定资格
  Worker 按产品语义保留。
- 北京真实 CLB termination 矩阵也已通过：同一流式普通 Worker 的首段响应先穿过公共 `/v1`，测试再
  精确删除实际持有 request permit 的 A Cell executor Pod。15 秒用例在 readiness 摘除后完整返回，
  Cell 私有 CLB 同时把新请求转移到健康 peer；75 秒用例超过 45 秒 drain 预算，timeout counter 精确
  增长 1，Pod 在约 60.2 秒强退，公共连接得到 `IncompleteRead` 而不是干净的截断 `200`，且平台没有
  重放请求。两次删除后 Deployment 均恢复精确三副本，A/B 最终都保持 3 Ready。不可变 receipt 为
  `stateless-termination-matrix-20260924.json`（SHA-256
  `d13dcb312019a03cfe5b28c5fc23fe3af615bf22e4b3b91e7d54710c1b328c53`），临时 Worker 已删除。

当前状态与剩余差距是：

1. `CellServingRoute/v1` 的 UID-bound schema、CAS publisher、manifest hash/revision 回退保护、
   Kubernetes resolver 与 Workers API 动态消费均已实现；生产 Workers API 已移除 A/B endpoint
   启动参数，路由变更不再要求重渲染或滚动 API Pod；
2. stateless executor、HPA/PDB、私网端点已有 evidence-bound Git 渲染、CAS 发布和逐 Cell Argo
   Application 接管路径；Secret 保持外置，具有 cluster-scoped RBAC 的 node-admission controller
   刻意留在可信平台安装面。北京 A/B 现网接管与公共 `/v1` 最小 smoke 已通过；从零重建永久资格链
   也已关闭：当前 Workers Git revision `6cbdfe96e2c92c2908dc68b054ee5f8239b38047` 会归档精确
   `workers-api-render.json`，舰队级收据同时验真 Code Plane rebuild、A/B qualification/route、
   历史 first-placement/CLB HA、当前 Workers/observability convergence、deployment cursor 和两层
   云上扩缩容，并重新读取 live ShardPool、Cell、route、Deployment、HPA 与 Argo revision。随后又把
   TKE NetworkPolicy controller 与真实 Registry→FDB 故障恢复证据纳入同一永久链；当前收据为
   `receipts/fleet/rebuild-qualification-networkpolicy-94239be8.json`（SHA-256
   `a7e7205e47bcc1b0fdeb82a9459bbf4cf609056aa2d81e0cbace3b03bd413c82`），其中逐个绑定
   C/A/B controller UID 与 3/3、20/20、29/29 Ready 状态；
   minisandbox 源码现以 mono2 的 `minisandbox/` subtree 为唯一真源；clean-room reviewed-source
   bundle v2 分别绑定 mono2 commit、repository tree、project path 与 project tree，同时仍把项目
   tree 作为归档根，避免把 mono2 其他服务带入 Runtime 构建或改变 builder 的目录契约；
3. Terraform 已改为通过 TKE 控制面创建独立、启用 autoscaling 的 Native NodePool，并将其动态
   `np-*` ID 写入 Cell inventory；Argo 不再伪造或拥有该 MachineSet。集群级 scale-in 已启用且一次
   最多缩一台。stateless admission profile、startup taint、精确 runtime digest probe 和 workload
   hard affinity 已实现；本地 A/B 已验证 compute/stateless 物理节点分离和镜像先准备后准入，本地
   确定性门禁也已完成负载驱动的 Node autoscaling、低容量扩起和安全缩回；新 Native NodePool
   路径的北京 TKE Cluster Autoscaler 同构门禁也已通过，证据与上述 receipt 绑定；
4. executor 的显式停止接流、readiness 摘除和有界 in-flight drain 已实现；本地永久门禁与北京生产
   CLB 同构证据均已覆盖 Pod termination、预算内请求完成和超时强退。Workers API 同时保证上游 body
   读取失败后中止下游 stream，关闭了“截断响应被当成成功 200”的窗口；
5. 本地 A/B 双 Cell 已把真实 Worker fetch、同 Cell/cross-Cell Durable Object、sleep/wake、
   stateless Pod replacement 固化为一键资格门禁；北京生产私网 CLB/CCN 已通过跨 A/B 的普通 Worker、
   Worker-to-DO `1,2,3` smoke，以及 sleep/wake 后逐个替换 Host、Workers API、Engine/Gateway 和
   stateless executor 的永久故障矩阵；请求执行中穿过真实 CLB 的 termination/drain 同构证据也已由
   独立流式矩阵补齐；
6. active Deployment 已使用 namespace-scoped 事务游标、Registry/FDB watch 和 Workers API
   有界 LRU 缓存；游标与 Deployment 指针在同一 FDB transaction 更新，watch 断线立即清空并
   旁路缓存，Registry 响应也携带同一事务快照中的游标以阻止迟到响应重新污染缓存。本地永久
   门禁已覆盖三副本 Registry replacement、Registry 全副本不可达时已有 Object cache hit 继续、
   新 placement miss fail closed 且不创建 Actor，以及恢复后的正常收敛。北京三副本 cursor 传播已完成
   20 轮、60 个样本的实跑，p50/p95/p99/max 分别为
   `0.041604/0.100047/0.131366/0.131366s`，临时 Worker 已删除；receipt 为
   `deployment-cursor-7284680b2/receipt.json`（SHA-256
   `332b5c8581ff38f74a799eeb12cf984947d83a7803c20a5ad58f624e258adb09`）。真实云上 FDB 网络边界也已
   补齐：此前 C/A/B 虽存在 NetworkPolicy 对象，但未安装执行 add-on，策略实际不生效；现由 Terraform
   固定安装 TKE `networkpolicy` 1.0.6，C/A/B controller 分别为 3/3、20/20、29/29 Ready。启用时发现
   FDB 旧 ingress 仅允许同 namespace，会阻止新的 regional Registry 连接；策略已显式放行平台所有的
   `worker-registry-system` namespace，并以源码测试固化。隔离 canary 强制建立新 FDB 连接后在
   5.593 秒内 `/readyz` 变为 503、`/healthz` 保持 200，解除策略后同一 outage Pod 在 5.243 秒内恢复，
   生产三副本 Registry UID 未变化，临时资源清零；receipt 为
   `receipts/fleet/fdb-network-outage-dd5f332f.json`（SHA-256
   `2e2446a4c986b91db092d569bcafb3f5e782590f400e691c2bfb3b0b49ccf729`）。A/B 启用后各替换一个 Engine
   Pod 并恢复 6/6 Ready，主 FDB 仍 `available=true/fullReplication=true`；
7. stateless pool 的 Pod HPA、指标、本地独立节点扩缩容证据和生产 TKE 永久门禁均已通过；
   中央 Object Router HPA、指标适配、Argo desired state、中文面板及本地 `3 -> 4 -> 3` 真实
   负载门禁均已具备。北京 C 曾因两个 Service 共享宽选择器，11 个 Pod 被重复展开成 22 个
   scrape target 并超过 `targetLimit=20`，两个 custom metric 因而全部消失。现已改为独占
   metrics Service identity，且 `targetLimit` 与 HPA `maxReplicas=30` 一致；修复后 C 在不手工修改
   副本的前提下从 11 安全缩回 3，Prometheus 恢复为每 Ready Pod 精确一个健康 target，两个
   custom metric 和两个 Argo Application 均健康。不可变 receipt 为
   `router-metrics-75e1c8164/router-metrics-recovery-qualification.json`（SHA-256
   `29d27f9822cb1950c1efa5f355d2968a9f7d4c9094c870dd7e4eeb4419f31f6c`）。C 的生产配置不变组合负载
   门禁也已通过：`1188914ae00fa41799d03f63315554a7` 使用真实私网 `/v1` 流式请求，225/225
   成功、峰值 225 in-flight，Router Pod 从 `3 -> 4 -> 3`，175 个连续样本中 HPA spec hash 始终为
   `ab678a35c9c5992f89d2b95911795d56fbb43717bf0dbe68eca908a07cdd4065`，临时 Worker 已删除。该负载同时
   触发了 A/B 的 hottest-Pod 保护信号，因此门禁不再把下游扩容当作与 C 无关的背景事件：
   它要求 A/B 的 stateless Pod 和 Native NodePool 在负载前后都精确为 `3/3`，本次最终依赖
   容量回落耗时 2453 秒。组合 receipt 为
   `workers-api-autoscaling-1188914ae00fa41799d03f63315554a7/receipt.json`（SHA-256
   `4026f79ea49039b37f887bf43977b98b8992b8c4295d7c4ef5bc6ae3560da1a5`）。尚缺真实告警投递
   receipt；
8. Phase 5 的 Router 性能证据已实现为独立负载器与只读采集器：它分别绑定通过的 10k 容量 qualification
   receipt 与至少持续五分钟、完成一万次无重试 Worker binding→Object 请求的性能 load receipt，按后者精确 UTC
   时间窗从 Hub Prometheus 回放 Object QPS、p50/p99/p999、placement cache
   命中率、Registry TPS/p99、bounded source/target Cell RTT、进程 CPU/RSS 和每 Object 请求 CPU，
   并先保存完整 query-range 原始响应再用 SHA-256 生成不可覆盖的汇总 receipt。Workers API 的私有
   Prometheus registry 同时增加 process collector，Hub recording rules 与中文 Grafana 面板已接入
   CPU、单请求成本和 RSS。缺失 series、仅 NaN、非通过的 10k 门禁或不存在不同 source/target Cell
   的 RTT 都会 fail closed。性能负载必须经 `/workers/{worker}/dispatch` 进入 stateless executor，并把
   Object 均衡预置到至少两个 placement-ready Cell；直接 ObjectRef 因 `source_cell=unassigned` 会被拒绝，
   不得冒充跨 Cell 证据。真实 10k 运行及新指标发布后的云上 receipt 仍是 Phase 5 未完成项。
   10k observer 还会把两 Cell 的 FDB CR configured/generation/available/fullReplication/healthy
   和全部 FDB Pod readiness 纳入每个 complete sample；存储冗余降级时即使请求暂时成功也不能
   取得容量资格。
   首轮正式 10k 运行 `f9e4a8e0af77cf048edb96e6c7b0c5f4` 在 8,298 active 时严格失败：旧 Host
   HPA 的 `Max + Percent 100` 在默认 tolerance 下把 235→260 的需求作为一批提交，B Cell 同时接入
   约 21 个 Envoy 后 Actor allocate p99 达 22.9 秒、Guard ready-wait p99 达 49.5 秒并产生两次
   indeterminate。Engine 仍 6/6、FDB 始终可用且全复制，因此修复不是扩 FDB 或放宽重试，而是把
   production/q01 Host 扩容改成 `Min(Pods 6/min, Percent 100/min)`，将大 Cell 的 membership cohort
   限在每分钟六个；待旧容量安全缩回后必须用相同零重试门禁重跑。
   第二轮 `354610a58f4a66c7e0b4ec8d7978cbda` 从零 active/零 compaction waiter 启动，仍在
   8,868 created 时严格失败。B 的后台 compaction 达 48 in-flight/1,258 waiters、manager refresh
   达 96 in-flight/151 waiters；交互 UDB 事务升至秒级，而 Engine/FDB CPU 未饱和。最早故障是七次
   B Cell indeterminate，随后 initialize 失败触发停止；127 个同时取消错误属于停止扇出。
   下一候选将每 Engine refresh/compaction 默认值从 `16/8` 调整为 `8/2`，六副本 Cell 的总上限为
   `48/12`；并以 drop guard 修复 UDB transaction future 取消后 pending gauge 不下降的观测错误。
   参数校准仍须由同一 strict 10k receipt 证明，同时检查 hot bytes、waiter 年龄与 cold publish 进度。
   第二轮清理已证明 Object cleanup 成功、两 Cell active 归零，但 A Node 自动缩容暴露另一项缺陷：
   控制器在持久化 prepared 意图后，以旧“无意图”快照清掉同一 Node 的 drain fence，继而持续
   fail closed。修复在 orphan 恢复前以服务端 MachineSet UID/resourceVersion CAS 确认快照，
   并仅对 exact UID 未变、零 provider attempt、零 RequestID、完全缺失 fence 的意图安全取消后
   重新评估。已尝试删除、替换 UID、其他 owner 或部分 fence 不允许自动取消。Go 回归覆盖此
   次事件顺序；真实 controller 发布后安全缩回低容量仍需独立证据，不能以 cleanup passed 代替。
9. durable command 的 ACK-of-ACK 已完成代码和本地确定性门禁。协议把 checkpoint 的释放绑定到
   服务端 FDB commit 后返回的 barrier，并将单事务 ACK 限制为 `512` 条；断线后的相同 ACK 与空 range
   clear 均为幂等。剩余证据不是继续修改协议，而是在北京 A/B 的真实 Host/Engine/FDB 链路精确注入
   ACK 已发出、commit 或 barrier 尚未被客户端确认时的连接中断，并冻结 command backlog、Actor
   generation、Start/Stop 副作用次数与最终清零 receipt。

## 用户语义

### 普通 Worker

```js
export default {
  async fetch(request, env) {
    return new Response("hello");
  },
};
```

普通 Worker 的每次请求可以落到不同进程、不同节点或不同 Cell。平台可以复用 warm isolate，
但用户不能依赖上一次请求留下的全局变量。版本按请求从当前 Deployment 选择；发布比例、代码
准备失败和回滚不改变 URL 或 Worker 名称。

### Worker 调用 Durable Object

```js
export default {
  async fetch(request, env) {
    const id = env.COUNTER.idFromName("account-42");
    return env.COUNTER.get(id).fetch(request);
  },
};

export class Counter {
  constructor(state, env) {
    this.state = state;
  }

  async fetch() {
    // Native Durable Object SQLite/Depot path.
  }
}
```

`COUNTER` 来自该不可变 Version 的 binding：

```text
binding name COUNTER -> same Worker export Counter -> durable namespace key
```

binding 对象由可信 loader 注入。闭包中固化 namespace、Worker、class 和 namespace generation；
用户只能选择 object name/ID 和请求内容，不能伪造目标租户、Cell、Actor 或 generation。

### 直接寻址的持久 Agent

现有公共接口继续存在：

```text
PUT    /v1/workers/{worker}/objects/{class}/{object}
ANY    /v1/workers/{worker}/objects/{class}/{object}/fetch
DELETE /v1/workers/{worker}/objects/{class}/{object}
```

它适合 Agent SDK、后台服务和运维工具。普通 Worker binding 和直接 ObjectRef 最终进入同一个
Object Router，不允许形成两套 placement 或生命周期真值。

## 两种执行面

### Stateless executor

stateless executor 是新的执行进程/模式：

- 不注册为 Rivet Actor host；
- 不持有 Actor generation lease；
- 不挂载 SQLite bridge 或 Depot writer；
- 复用不可变 Worker code cache、WorkerLoader 和 V8 限制；
- 按 `(namespace, worker, version_id, local_slot)` 管理有界 isolate pool；
- 以 CPU、RSS、in-flight、queue 和 cold-start rate 做 Pod/Node 扩缩容；
- Pod drain 只需停止接新请求并等待有界 in-flight 请求结束。

一个热 Worker 可以在多 Host、多 isolate 上并行执行。一个 isolate 也可以并发处理等待 I/O 的
请求；CPU 压力、heap 压力或队列水位触发增加 isolate/Pod，而不是创建持久 Actor。

### Durable host

durable host 保留现有 Rivet Actor 路径：

- Pegboard 持有 `(actor_id, generation, envoy_key)` 单活租约；
- 每个 active Object 占用 durable host slot；
- SQLite/Depot、idle sleep、wake、generation fence 和 actor-aware drain 保持不变；
- 容量以 active Actor、私有内存、SQLite cache、I/O 和恢复水位计算。

一个热点 Durable Object 不能在保持单线程/单活语义的同时无限横向扩展。应用必须按用户、房间、
文档或其他业务 key 拆分为多个 Object。平台横向扩展的是 Object 数量，不是一个 Object 的写 owner。

### 部署边界

生产目标是在每个 runtime Cell 使用两个节点池：

| 节点池 | 调度单位 | 主要资源 | 缩容条件 |
|---|---|---|---|
| stateless execution | request/isolate | CPU、RSS、queue | 停止接流并 drain in-flight |
| durable actor | active Object | memory、NVMe cache、FDB/COS I/O | actor-aware drain，不能强删活 owner |

两个进程可以来自同一个 digest-pinned runtime 镜像并共享代码模块，但必须使用不同 entrypoint、
ServiceAccount、资源配额、节点 label/taint 和 HPA。bootstrap 环境允许临时共用 Kubernetes 节点，
产品容量和缩容资格不得把两者混为一类。

生产命名空间同样分离：durable/FDB 数据面位于 `actor-fdb-cell-system`，Argo 管理的 stateless
workload 位于 `actor-stateless-system`，具有 Node/Machine patch 权限的 admission controller 位于
`actor-runtime-admission-system`。Cell Argo 凭据只允许前两个 namespace，且在 FDB namespace 只能
管理 `RivetCell`；否则即使 RBAC 禁止读取 Secret，也可以通过创建 Pod 挂载 Secret 或复用特权
ServiceAccount 间接越权。

## 三层寻址模型

### 第一层：逻辑 Object 到不可变 placement

逻辑主键是：

```text
ObjectKey = tenant + namespace + worker + durable_namespace_key + object_id
```

当前部署把 namespace 固定为进程配置；引入多租户后，tenant/namespace 必须来自已认证 principal，
不能来自可任意覆盖的用户 header。

`idFromName(name)` 使用版本化、域隔离的确定性哈希：

```text
sha256("rivet-do-id/v1" || tenant || namespace || durable_namespace_key || name)
```

结果仍为 64 个小写十六进制字符。namespace key 防止两个 binding/class 或删除后重建的 class
意外共享同一对象空间。`idFromString()` 只验证并封装已有 ID；`newUniqueId()` 使用 CSPRNG。

Registry 中已有的 `DurableObjectRecord` 是权威记录：

```text
ObjectPlacement {
  pool_name
  pool_uid
  snapshot_resource_version
  snapshot_digest
  cell_name
  cell_uid
  datacenter
  decided_at
}
```

首次 claim 在 FDB 中原子提交 placement。已有记录忽略新的候选决策。Object 删除产生终态
tombstone，迟到请求不能重新创建它。

### 第二层：Cell UID 到稳定 serving endpoint

新增只读、可审计的 `CellServingRoute`：

```text
CellServingRoute {
  schema: "actor-cell-serving-route/v1"
  region
  pool_name
  pool_uid
  cell_name
  cell_uid
  datacenter
  actor_gateway_authority
  stateless_executor_authority
  service_identity
  revision
  manifest_sha256
  published_at
}
```

约束：

- Router 以不可复用的 `cell_uid` 为主键；`cell_name` 只用于人类观察；
- placement 的 `cell_name + cell_uid + datacenter + pool_uid` 必须与 route 全部一致；
- authority 是私有 DNS/CLB，不是 Pod IP、ClusterIP 或短生命周期节点 IP；
- route 不携带 bearer secret；服务认证使用 mTLS/workload identity，bootstrap 阶段可使用独立的
  bounded internal token；
- admission/`accepting` 与 serving route 分离。Cell 关闭新 placement 后仍必须服务已有 Object；
- route 只有在 placement count 为零且 retirement proof 完成后才能撤销；
- 同名重建 Cell 会产生新 UID，绝不能继承旧 placement；
- endpoint 变更通过新 revision 和 CAS 发布，Router 拒绝 revision 回退。

现有 `actor-cell-route-*` immutable ConfigMap 可以扩展/派生该记录。C 中 Fleet/Argo 拥有发布权；
Cell 只能报告自身身份与健康，不能自行把任意 endpoint 写入受信路由。

### 第三层：Actor ID 到 live owner

Object record 激活后保存稳定 `actor_id`。Router 只把请求发到 placement Cell 的 Gateway：

```text
actor_id -> Engine/Pegboard -> current envoy_key/generation -> durable Host
```

Router 不缓存 Host、Pod、generation 或 Unix socket。Object sleep、wake、Host replacement 和普通
rollout 不改变前两层地址。Pegboard 与 Depot generation fence 保证旧 owner 不能继续提交。

## 请求路径

### 发布 Worker

```text
upload modules/config/bindings
  -> Registry creates immutable Version
  -> prepare/canary on compatible stateless and durable entrypoints
  -> CAS publish Deployment
  -> stateless and durable Hosts fetch by immutable version_id
```

普通 fetch 和 Durable Object class 必须分别 prepare。只有 default fetch 成功不能证明 class export、
SQLite capability 或 Object construction 可用。

### 普通 Worker fetch

```text
client/site-gateway
  -> C Workers API
  -> authenticate + resolve namespace/Worker Deployment
  -> choose Version for this request
  -> choose admitted stateless Cell/Host
  -> stateless executor WorkerLoader
  -> user fetch
  -> streamed response
```

`/v1/workers/{worker}/dispatch` 将从“default persistent Actor”改为该路径。项目尚未上线，不保留
错误语义的兼容层。直接持久 Agent 必须使用显式 ObjectRef API。

### 首次 Worker-to-Object 调用

```text
user Worker
  -> trusted DO binding wrapper
  -> C regional Object Router internal listener
  -> bounded route cache miss
  -> Registry ClaimObject(nil)
       existing: return ObjectPlacement + actor_id
       missing:  placement_required
  -> fresh PlacementResolver selects admitted Cell
  -> Registry ClaimObject(placement), atomically persist
  -> target Cell Engine creates keyed Actor
  -> Registry ActivateObject(actor_id)
  -> cache (ObjectKey -> actor_id + Cell UID)
  -> target Cell private Gateway
```

多个 Router replica 或多个 Worker 请求并发首次调用时，FDB claim、Rivet keyed create 和 activate
必须收敛到同一 Actor。进程内 single-flight 只减少重复工作，不是正确性锁。

### 稳态 Worker-to-Object 调用

```text
binding wrapper
  -> Object Router replica
  -> bounded LRU hit
  -> Cell UID route hit
  -> pooled HTTP/2 connection to private Gateway
  -> actor_id
```

稳定请求不访问 Registry/FDB。每个 Router replica 的 cache 相互独立，丢失整个 cache 只造成可控
的重新解析，不改变 placement。cache key、指标和日志不得把 Object ID 作为 Prometheus label。

### Sleep、wake 与跨 Cell

Object 休眠只释放 live owner：

```text
ObjectKey -> Cell UID -> actor_id     remains stable
actor_id -> live generation          removed while sleeping
```

下一次 fetch 到达同一个 Cell Gateway 后由 Pegboard 唤醒新 generation。

第一阶段 Worker-to-Object 请求经 C Router 直达 owner Cell，不要求普通 Worker Pod 访问另一 Cell。
现有受控 peer path 仍保留：

```text
runtime A Gateway -> CCN -> runtime B private Gateway:443
runtime B Gateway -> CCN -> runtime A private Gateway:443
```

它用于现有 Guard peer forwarding，也为将来把 Object Router 下沉到 execution Cell 提供路径。
非 Gateway Pod 到 peer VPC 的流量继续拒绝。

## Router 组件边界

把现有 `workersapi.ensureActor()` 拆成可独立测试的内部组件：

```text
ObjectRouter
  - ObjectRegistryClient
  - PlacementResolver          // only needed for first claim
  - CellRouteResolver          // UID-bound serving routes
  - ActorProvisioner           // keyed create/activate/delete
  - PlacementCache             // bounded TTL/LRU
  - single-flight miss table   // bounded, not correctness authority
  - FetchTransport             // streaming, pooled per Cell
```

HTTP handler 只负责认证、限流、请求大小、原始 URL、错误映射和 streaming。公共 ObjectRef API 与
Worker 内 binding 调用同一个 `ObjectRouter`。

第一阶段 Router 作为 C Workers API 中的模块运行，并在独立 internal listener 暴露 host-to-router
协议。该模块必须避免依赖全局变量和 handler 类型，以便后续原样构建为 Cell-local Router。

### 内部调用协议

建议的首版 endpoint：

```text
ANY /internal/v1/objects/{worker}/{class}/{object_id}/fetch
```

可信 stateless Host 从不可变 Version binding 生成目标，并附加：

- authenticated namespace/tenant context；
- caller Worker、Version 和 binding；
- request ID、trace context；
- 原始 URL；
- 可选的用户幂等键。

Router 必须删除客户端同名内部 header，再写入经过认证的值。用户 Worker 不获得 raw Router
Fetcher、内部 token 或可修改 namespace/class 的接口。

内部协议使用固定版本 path、CBOR metadata 和 streaming HTTP body；不得使用无版本的 raw
`serde_bare`。首版若暂时使用 HTTP header，必须有严格长度、字符集和总 header 大小限制，并把
协议版本固定在 path 中。

## 缓存与规模

百万 Object 并不意味着每个 Router 保存百万条记录：

- placement cache 使用容量 + idle TTL 的 LRU，默认可沿用当前 `32,768 / 10 min` 作为起点；
- cache 只覆盖近期活跃 Object，Registry/FDB 保存完整百万级真值；
- 相同 Object 的并发 miss 在单 replica 内 single-flight；
- negative cache 只缓存确定性的 terminal tombstone/不存在，TTL 必须短；
- Cell route 数量只与 Cell 数量有关，可以完整常驻内存；
- 每个 Cell 建立少量 HTTP/2 connection pool，不为每个 Object 建连接；
- Registry claim 只发生在首次创建或 Router cache miss，不发生在每次 fetch；
- stateless code cache 按 immutable Version，而不是按请求或 Object 保存。

当中央 Router QPS 接近单区域上限时，按以下顺序扩展：

1. 增加无状态 Router replica；
2. 调整有界 cache 与 connection pool；
3. 将 Router proxy/cache 下沉到每个 execution Cell，首次 miss 仍调用 C 的 resolve/claim；
4. 只有证据表明 C miss path 成为瓶颈时，才向 Cell 分发签名的 admission snapshot，让 Cell-local
   Router 自主执行首次 claim。

不能为了省一次网络 hop 就让每个 Cell 读取 C 的 Kubernetes API。

## 失败、重试与一致性

### 允许自动重试

- 在尚未向目标发送 request body 前发生的 DNS、connect 或 TLS 失败；
- Registry 的确定性只读；
- FDB 返回明确未提交的 transaction；
- 幂等的 claim/activate/delete 状态机步骤；
- 调用者提供幂等键且目标 Object 明确实现去重的业务请求。

### 禁止透明重试

请求 body 已经可能进入用户代码后发生断线时，Router 不能自动换 Host/Cell 重放。它必须返回
`indeterminate_result` 或等价的可识别错误。Object 单活只能防止双 owner，不能证明一次 HTTP
调用没有产生副作用。

### 典型故障行为

| 故障 | 行为 |
|---|---|
| 一个 Router Pod 退出 | Service 转到其他副本；cache miss 重新解析 |
| Registry/FDB 短暂不可用 | cache hit 的已有 Object 可继续；新建/cache miss fail closed |
| Cell 关闭 admission | 不再放置新 Object；已有 Object 继续路由 |
| 目标 Cell Gateway 不可达 | 返回 retryable unavailable，不改 placement、不跨 Cell 夺主 |
| Actor sleeping | 同一 actor_id 触发正常 wake |
| Host/Pod replacement | Pegboard 分配新 generation；Router 地址不变 |
| 同名 Cell 被重建 | UID 不匹配，Router fail closed |
| route revision 回退/缺失 | 不猜测 endpoint，不使用仅按名字匹配的旧路由 |
| Router 在 activate 响应前崩溃 | 重试从 Registry 读取已提交状态；不盲删 Actor |
| DELETE 后迟到 fetch | terminal tombstone，不能复活 Object |

## 版本与 Deployment

普通 Worker 的 Deployment 选择是 request-scoped。Durable Object 的代码选择是 object-scoped：

```text
stateless bucket = hash(request rollout key)
durable bucket   = hash(namespace, worker, actor_id)
```

Durable bucket 不包含 `deployment_id`。只创建一个语义相同的新 Deployment 不应重新随机分配所有
Object；只有有序版本区间实际覆盖变化的 Object 才切换 Version。Host 在切换前验证新 Version，
切换只重载代码，不改变 Object、Actor ID 或 SQLite identity。

Version-local binding 决定当前普通 Worker 能看见哪些 DO namespace。发布包含两个 Version 的渐进
Deployment 时，Registry prepare 必须分别验证每个 Version 的 default export、binding target 和
DO class export。第一阶段要求同名 binding 在 rollout 的所有 Version 中指向兼容的 class/namespace；
跨 class migration 需要独立协议，不能通过悄悄改 binding 完成。

### Active Deployment 缓存与失效

普通 Worker 请求不能每次读取 Registry/FDB，也不能用普通 TTL 假装 active Deployment 永远不会
变化。当前协议使用一个不承载业务含义的 namespace-scoped opaque cursor：

1. Registry 在替换或删除 active Deployment 的同一 FDB transaction 中写入新的随机 cursor；
2. `GET /internal/v1/namespaces/{namespace}/deployment-cursor?after=...` 使用 FDB watch 长轮询，
   heartbeat 只确认连接存活，不制造新 revision；
3. 每个 Workers API replica 只在 watch 已同步时启用容量为 4,096 的 active Worker LRU；
4. cursor 改变时清空整个 namespace cache。Worker 数量有界，这比维护可能丢事件的 per-Worker
   change log 更容易证明；
5. watch/Registry 不可达或响应身份不合法时，缓存 fail closed，dispatch 回到普通 Registry 读取；
6. Worker 读取结果包含同一 Registry transaction 看到的 cursor，只有 cursor 和本地 generation
   都未变化时才能写入 cache，避免失效期间的迟到响应恢复旧 Deployment。

发布与已经开始的请求并发时，旧请求允许完成；cursor 被观察后发起的请求选择新 Deployment。
这不是时间 TTL，也不把缓存变成真值。多副本间传播延迟由持续长轮询和 25 秒 heartbeat 约束，
真实三副本故障资格测试必须测量并记录其 p99，而不能假定发布响应等于所有 replica 已 ACK。

## 安全与网络不变量

### 允许的区域流量

在现有 `ccn-plan.yaml` 上增加精确 flow，而不是开放 VPC 全互通：

```text
site-gateway              -> C Workers API public/private boundary:6688
C Workers API/Dispatcher  -> Cell stateless executor private CLB
C Object Router           -> Cell Actor Gateway private CLB:6420/443
Cell stateless Host       -> C Object Router internal CLB:dedicated port
Cell runtime Host         -> C Worker Registry private CLB:8080
Cell A Gateway            -> Cell B private Gateway:443
Cell B Gateway            -> Cell A private Gateway:443
```

继续禁止：

```text
operations VPC -> runtime Cell
ordinary Cell Pod -> peer Cell VPC
C -> Cell FDB/NATS/Pod CIDR/Service CIDR
Cell -> operations VPC
cross-region Actor CCN
```

Kubernetes ClusterIP 不能用于跨集群地址。所有跨集群 endpoint 必须是私有 CLB/DNS，并由 SG、
NetworkPolicy 和应用层身份共同限制。CCN 只提供 L3 reachability，不提供授权。

### 信任边界

- 外部请求在 C Workers API 完成 authn、tenant/namespace 绑定、配额和请求限制；
- 用户代码、URL、header、body 和 Object name 全部不可信；
- stateless/durable Host 与 Router 之间是内部协议，但仍校验 framing、大小、deadline 和身份；
- Router 到 Gateway 使用每服务身份，不共享用户 token；
- hypervisor/PVM 若承载 Host，仍把整个 guest 视为不可信，broker 重验所有长度和 capability；
- route、placement、Actor owner 三类状态各有唯一 owner，cache 永远不成为真值。

## 代码改动位置

### `infra/cells/internal/workersapi`

1. 新增 `objectrouter` 子包，迁移 `ensureActor()`、claim/activate、Actor create/delete、fetch 和
   bounded cache；
2. 新增 `CellRouteResolver`，把 `engineByCell map[cell_name]URL` 改为按 `cell_uid` 查询并校验
   name、UID、datacenter、pool UID；
3. 增加 bounded single-flight miss；
4. 公共 ObjectRef handler 和内部 Worker binding handler 共用 Router；
5. 把 `/dispatch` 改为 stateless dispatcher，不再计算 default Object ID；
6. 内部 listener 与公共 listener 分离，内部 route 不出现在公共 `/v1`；
7. 保留统一 `APIError`，增加 `route_stale`、`object_unavailable`、
   `indeterminate_result`、`executor_overloaded` 等稳定错误。

### `infra/cells/internal/workerregistry`

基础路径不需要更换 `DurableObjectRecord` 或 FDB object key。需要：

1. 明确并返回 durable namespace key/generation，供版本化 `idFromName` 使用；
2. 校验 rollout 中每个 Version 的 binding/export 兼容性；
3. 保持 claim、activate、terminal delete 和 placement counter 的同事务不变量；
4. 给 Router 提供 bounded batch resolve 仅作为重启预热优化，不能引入全表扫描；
5. tenant 上线前把 namespace 从进程常量提升为认证上下文，并保证所有 FDB/COS prefix 隔离。
6. active Deployment 变更游标必须与指针同事务提交；生产后端使用 FDB watch，不能退化为
   request-path polling 或 TTL。

### `runtimes/workerd/host`

1. 把 `WorkerCodeCache`、Version 验证和 workerd transport 提取为 durable/stateless 共用模块；
2. 新增 `rivet-workerd-executor` 二进制或明确的 `--mode=stateless` entrypoint；
3. stateless 模式不启动 Envoy Actor lifecycle 和 SQLite bridge；
4. WorkerLoader 为每个 immutable Version 构造 default fetch 和经过能力约束的 DO bindings；
5. binding wrapper 将 fetch 流式发送给 internal Object Router，并隐藏原始 Fetcher/token；
6. 增加 isolate pool、并发/排队/CPU/RSS 限制和 graceful drain；
7. durable 模式继续提供 `RIVET_STORAGE`，但它不是普通 Worker 的全局存储。

优先使用同一个镜像中的两个小 entrypoint，避免复制沉重的 workerd 构建；只有依赖和攻击面证明
必须分离时才拆镜像。

### `runtimes/workerd/miniflare`

1. `dispatchFetch()` 改走真正的 stateless endpoint；
2. `getDurableObjectNamespace()` 保留直接 ObjectRef 行为；
3. 增加 Worker 内 `env.BINDING.get(id).fetch()` 的兼容 E2E；
4. 文档明确 isolate reuse 不是状态保证，DO 才有稳定 identity；
5. 保持 `setOptions()`、Version/Deployment CAS 和失败原子性规则。

### Fleet、Terraform、Argo 与网络

1. Fleet route publication 生成 UID-bound `CellServingRoute`；
2. C 的 Argo desired state 部署三副本 Router/Dispatcher、PDB 和 internal CLB；
3. 每个 Cell 增加 stateless executor Deployment、Service、HPA、PDB、ServiceAccount 和节点池标签；
4. Terraform 创建精确 SG/listener/DNS，不写 Pod/Service CIDR 路由；
5. runtime admission controller 分别验证 stateless/durable runtime digest 和节点能力；
6. capacity controller 分开计算两类节点容量，不能用 active Actor 指标扩 stateless pool；
7. Cell drain 先从 stateless dispatch candidates 移除，再 drain 请求；durable pool 继续执行现有
   actor-aware drain；
8. 新 Cell 仍由 Terraform + Argo + qualification 建设，人工 `accepting=true` 后才进入新 placement。

## 分阶段落地

### Phase 0：固定路由身份

- 定义 `CellServingRoute/v1`；
- `engineForPlacement()` 强制匹配 Cell UID；
- route snapshot 加入 manifest verification 和回退保护；
- 保持当前持久 `/dispatch` 暂时不变。

验收：同名 Cell UID 替换、旧 ConfigMap、缺失 endpoint 和 revision 回退全部 fail closed。

### Phase 1：抽取 Object Router

- 从 Workers API 抽取 Router 包；
- 公共 ObjectRef API 无行为变化；
- 增加 single-flight、cache/Registry/route 指标；
- 三副本竞争、Pod replacement 和 stale cache E2E 通过。
- 首次生产接管使用显式 `object-router-bootstrap` desired state；此阶段不得引用不存在的 stateless
  endpoint/serving route，也不得把 stateless executor capability 注入 Pod。Router endpoint 安装完成
  后才允许发布最终 `serving` desired state，禁止用占位地址或手工 patch 打破依赖环。

验收：Counter 连续递增，重启任意 Router、Registry client、Engine API Pod 后 Object ID 和状态不变，
Registry claim rate 与 cache miss 而不是请求 QPS 成正比。

### Phase 2：最小 stateless executor

- 新增 executor entrypoint 和节点池；
- 支持 default fetch、不可变 Version、prepare、限流和 streaming；
- `/dispatch` 切换到 stateless 语义；
- 暂不注入 DO binding。

验收：同一 Worker 在多个 isolate、Pod、Cell 执行；全局变量不构成测试断言；扩缩容不中断已开始
请求；坏 Version 不能成为 active Deployment。

### Phase 3：Worker-to-DO binding

- 注入 capability-bound namespace；
- 增加 internal Router listener 和精确网络 flow；
- 首次 lazy claim、同 Cell、跨 Cell、sleep/wake 全链路通过；
- 直接 ObjectRef 与 Worker binding 命中同一个 Object。

验收：A 中 Worker 调用 placement 在 B 的 Counter，B 中 Worker 反向调用 A；并发首次调用只产生
一个 active Actor；Router、Host 和 Gateway 逐个替换后计数继续递增。

### Phase 4：容量与无人值守运营

- stateless HPA/Node autoscaling 使用 queue、CPU 和 RSS；
- durable pool 继续使用 active Actor 和存储水位；
- 两类 pool 分别完成 scale-up、bin-pack、spillover、drain 和 scale-down；
- Router 按 QPS/in-flight 扩容，以 CPU/RSS 兜底并观察 latency；FDB 按 miss/transaction latency 监控。

验收：从低容量自动扩到目标负载后安全缩回；扩容期间不把未 admitted 节点加入调度；一次最多
自动修复一台 durable 节点。

### Phase 5：资格与演进决策

- 运行百万 dormant Object 元数据和万级 active Object 的分片容量测试；
- 量化 Router p50/p99/p999、cache hit ratio、Registry TPS、跨 Cell RTT 和每请求 CPU；
- 只有中央 Router 被证明为瓶颈后，才启动 Cell-local Router 下沉；
- 不把压测中发现的单 Cell 上限误写成整个产品上限，横向容量通过增加 Cell 扩展。

## 必须固化的测试矩阵

### 正确性

- 同名 `idFromName()` 在进程、Pod 和 Cell 重启后完全一致；
- 不同 tenant/namespace/class 不能生成可互换 capability；
- 100 个并发首次 fetch 只得到一个 Object/Actor；
- claim commit 前后、Actor create 前后、activate commit 前后逐点崩溃；
- DELETE 后 delayed retry 不得复活；
- Cell admission close 不影响已有 Object；
- same-name/new-UID Cell 不能继承旧 placement；
- DO gradual rollout 只在版本区间实际变化时重载对应 Object；
- stateless rollout 可以按请求分流，不产生持久 Actor。

### 网络与故障

- A Worker -> A Object；
- A Worker -> B Object 和反向路径；
- C Router 单 Pod/全部非 leader Pod 替换；
- A/B Gateway Pod replacement、CLB backend 更新；
- CCN 短暂丢包、TLS identity 错误、DNS stale；
- Registry/FDB 不可达时 cache hit 与 miss 的行为；
- 请求执行中断线返回 indeterminate，不自动重复副作用；
- 非 Gateway Pod 直连 peer Cell 必须失败；
- operations VPC 永远不能学习 runtime Cell route。

### 性能与容量

- 共享少量 Version 创建大量 Object，禁止每 Object 上传代码；
- Router cache 1%、50%、99% hit ratio 下的 FDB 和 CPU 曲线；
- 1/4/8/16+ Router replica 的线性扩展与负载均衡；
- 1,000/10,000 active Object 的 wake storm；
- 热 stateless Worker 的 isolate/Pod 扩容；
- 单热点 DO 的 overload 行为与多 key 分片后的扩展；
- 长响应 streaming、客户端取消和 backpressure；
- cache 容量达到上限后 RSS 保持有界。

## 可观测性

至少提供以下 bounded metrics；不得使用 Object/Actor/request ID 作为 label：

```text
worker_dispatch_requests_total{namespace,pool,result}
worker_dispatch_queue_depth{namespace,pool}
worker_isolates{namespace,pool,state}
worker_cold_start_seconds{namespace,pool}

object_router_requests_total{namespace,source_cell,target_cell,result}
object_router_cache_requests_total{namespace,result=hit|miss|negative}
object_router_registry_seconds{namespace,operation,result}
object_router_route_revision{pool,cell}
object_router_inflight{namespace,target_cell}
object_router_indeterminate_total{namespace,target_cell}

durable_object_wake_seconds{namespace,pool}
durable_object_active{namespace,pool}
```

Grafana 分开呈现 stateless execution、Object Router、durable runtime 和 Registry/FDB。扩容决策只
消费对应执行面的指标；跨 Cell QPS、失败率和 RTT 用 bounded Cell label 观察。

## 所有权与核心不变量

| 状态/动作 | 唯一所有者 |
|---|---|
| Worker Version/Deployment/bindings | Worker Registry |
| 新 Object 的 Cell placement | Registry FDB transaction + fresh PlacementResolver decision |
| Cell serving endpoint | Fleet/Argo published UID-bound route |
| Actor live owner/generation | Engine/Pegboard |
| SQLite durable commit | Depot/FDB generation-fenced transaction |
| stateless isolate cache | executor-local，可随时丢弃 |
| Router placement cache | Router-local，可随时丢弃 |
| Node/Pod capacity | 对应 pool 的 capacity controller/HPA |

必须始终成立：

1. cache 不拥有真值；
2. Object placement、Cell serving route 和 Actor live owner 不合并成一张模糊路由表；
3. admission 关闭不等于 serving route 删除；
4. Cell name 不构成防 ABA 身份，Cell UID 才是；
5. 普通 Worker 的 isolate 不是 Actor；
6. 用户代码不能自行构造跨租户 DO capability；
7. 网络可达不等于被授权；
8. 单活不等于 HTTP exactly-once；
9. 跨 Cell 调用只经过受控 Gateway/Router，不暴露内部数据库或 Pod 网络；
10. C 是区域入口和首版 Router 的 HA 部署位置，但不是 Actor generation、SQLite writer 或
    Cell 内恢复的正确性所有者。

## 与已有设计的关系

- Worker Version、Deployment、GC 与 Durable Object storage identity 继续遵循
  `2026-08-31-workers-durable-objects.md`；
- Rivet Actor V1 ID、Guard peer forwarding 和未来迁移遵循
  `2026-08-23-actor-routing-identity.md`；
- VPC、CCN、私有 CLB、跨 Cell Gateway 和区域隔离遵循
  `infra/cells/deploy/tencent/fleet/network/ccn-plan.yaml`；
- 本文的 Object placement 不是 Actor migration route。第一阶段 Object 固定在初始 Cell；
- 本文确定普通 Worker 与持久 Object 的组合模型，并定义两者之间缺失的内网寻址层。
