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
   Workers API 的 bootstrap/serving 渲染同时要求产品 ref、sourceRevision、sourceManifestDigest
   和原始收据字节 buildReceiptDigest 与完整 inventory 的 exact workers-api 项一致。仅基础镜像
   依赖相同不能授权另一产品；渲染前一次读取产品收据，校验和输出证据使用同一字节快照。
   永久回归通过真实 11 产品/28 镜像清单和 CLI 子进程覆盖错镜像、错源码、重新格式化的收据
   以及清单自校验正确但收据 digest 不同的拒绝路径，两种阶段都不得输出 manifest 或 receipt；
   正式 Workers API 门禁从操作目录调用时，先进入各测试 suite 的源码目录，再使用模块名称执行
   unittest；不能依赖绝对测试文件路径的解释。Fleet 静态入口加入真实复制源码、带点号父目录、
   unrelated cwd 的回归，避免 clean-room source 在 builder 上无法执行同一门禁；
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
   性能入口在任何代码发布或 Object 创建前检查 Registry `/readyz`，集群外 builder 通过 Hub
   Service port-forward 访问，不直接消费 C 内部 DNS。准备失败也进入精确 Object 清理并记录失败
   receipt，包括响应丢失的已尝试 ID；未确认存在的 ID 才允许 DELETE 404。正常和异常退出均关闭
   forward，失败不重试非幂等 dispatch。延迟直方图只包含正式负载窗口，不混入预置请求。
   2026-10-02 新运行 `f56405fe9169424fb97d3c81b3da2704` 在1517 Object时严格失败，
   09:20:41 UTC四次活跃 heartbeat返回502 `indeterminate_result`。C日志均指向B Engine
   等待响应头超过25秒，不能用增大超时、重试成功或健康FDB改判。原load收据SHA-256
   `151c16bb56db0d23d818158c9ac7c63ac58d7c99ee63c03a0b78f1b5c3d73eb1`，原精确cleanup
   收据SHA-256 `ce1b35b0af49f5c27df03713da5fe6d1325003c9357906b221dd3e8a7cbff9df`证明
   1517对象已删除、pending0；任务已通过生产串行drain缩回A/B各4个Node与Host。A/B实际峰值48/45个Node与Host
   全部Ready且Node admitted，Engine/Host无重启、FDB9/9全复制，不替代业务零错误资格。
   最终组合收据SHA-256 `794e64a9ceb34e07945a45560f45cfc63110be629fb7444016ee129195c7ae24`
   保留 failed verdict；150个完整容量样本证明初始低容量、自动扩容、精确清理、安全drain和最终
   低容量，不证明万级持续活跃。不得用节点恢复或业务重试成功替代该失败事实。
   针对此次等待响应头超时，Workers API 的 Object fetch 传输失败日志增加客户端 connection、
   request-written 与 first-response-byte 里程碑，区分 acquiring/writing/awaiting/reading 阶段。
   只记录固定阶段、毫秒耗时和 socket 地址，不记录 body、header、URL query，也不新增高基数
   metric。里程碑不能证明目标是否执行或提交，因此仍返回不可透明重试的 indeterminate；
   不改变25秒 response-header deadline 或 caller-owned streaming/cancellation。诊断代码通过本地
   验证后仍须正式发布和重新采集实际失败证据，不能据此认定该根因已修复。
   诊断API已通过2026-10-02正式发布 `inv-d9dft6gdrv`，Argo revision
   `87d5003cbea180edb1b3b02e3cc724462b7af34e`，API镜像
   `sha256:2b44930be720cadd47aa1a83941bf042f5fb910faac591a1e371e833abfa26ba`。
   convergence摘要 `9b9d3a9d2a8e464307baab6642fe0455e21a2f26ac56f2b81509e909ac03c810`，
   保留全部现有UID、A/B Application与Runtime，三节点三AZ及self-heal通过；独立只读重验
   `inv-e9dfw5g27n`再次确认十四资源、四路由与private endpoint一致，收据摘要
   `8e1b7b1ef88c04f0b206528f451a71ace3de5f738aade043964fcfd882ed2046`。
   发布与重验只完成诊断落地，不覆盖万级活跃资格或原超时根因。
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
   该事件还暴露了发布恢复顺序：旧 controller 无法取消卡住的意图，普通 release 却先等待 intent
   settle。正式 release 增加默认关闭的 controller-first 恢复阶段，先完成候选 config/image preflight
   和持久 immutable journal，再仅对 exact UID/zero-attempt/unfenced 状态 CAS 替换单副本
   controller；settle 门禁不删除。前置失败以原模板 CAS 回滚，回滚失败或进程硬中断保留 hold
   与 journal。该 journal 是 crash evidence，不代表 release 自动 resume；不以手工清 intent
   或绕过 static ledger 替代正式事务。
   builder 已通过该恢复流程的完整静态门禁，但 leaf image 晋级又发现基础制品约束：候选
   controller 的 Go base 与现行完整 inventory 不一致，promotion 正确拒绝。canonical foundation
   工厂还缺少 consumer 要求的 go.mod/go.sum OCI labels；工厂补齐已验证输入的 hashes，
   consumer 校验不放宽。改变 Go base 后必须闭合产品 reverse dependencies，再生成完整
   inventory；Runtime-base 未变化时不重复编译 Runtime/workerd。该工厂修复仍不代替云上 release。
   工厂增量构建允许严格选择已审阅 root，仍先验证完整 source manifest 与五项 foundation lock；
   完整 generation 仍需全部 11 个产品收据、28 个仓库及 exact dependency closure。未变化 root
   通过现有有效收据或全新隔离 registry cold-pull 复用，不把无关上游仓库可达性变成 leaf 发布前置。
   区域镜像复验入口从显式审阅的现有完整 inventory 继承 mirror provenance，并与 canonical upstream
   lock 精确比较；17 个区域 digest 各经独立空 VFS graph 拉取及实际平台检查后，生成新的 seed 和
   `actor-regional-image-seed-revalidation/v1` proof。它不访问公共上游、不恢复旧 seed preimage，也
   不声称独立验证 origin。新 seed 仍必须与 11 个依赖闭合产品收据组装成完整 28 项 inventory，
   才能进入正式 release；原 inventory 不被覆盖。
   北京 builder 的真实复验 `inv-d9d7am0pq3` 已通过 17/17 平台检查，canonical assembler 完成
   11/28 closure，新 inventory digest 为
   `sha256:8e85a0d9abb56c045d60d1f592d9e6172d224c7966ec428a2127b4ab4322e8c4`。它解除了
   镜像清单阻塞，不证明 controller 恢复、Runtime rollout 或 strict 10k 已通过。
   随后的正式 A controller-first release `inv-e9d7gqgp3v` 与 B normal release
   `inv-c9d83v01pt` 均已终态 SUCCESS/0；A 使用显式 recovery=1，B 不开启恢复路径。
   独立只读审计 `inv-d9d8a90q8b` 重新读取两 Cell static ledger、外部不可变 receipt、live workload
   与 Pod image IDs，均为零 drift，且两边 Engine 6/6、Host 4/4、controller singleton Recreate；
   既有 Host/controller UID 未变、Host revision 已收敛、release hold 正常释放。
   两边现场配置均精确为每 Engine refresh=8/compaction=2，主 FDB available/fullReplication/healthy
   且 generation=reconciled=2。Cell-neutral release artifact digest 为
   `sha256:3a3f47792c10d999358cdfe5e8e616dbcebad8344605d83d171c5924522c3ea0`；
   A/B releaseId 分别为 `sha256:a6ce4fc13fa7294e2e78c152820ed978f521b689affe3fea1af60eba9b9effdd`
   与 `sha256:847138778c90244666e9c625eba9d14b6e985a772c2e3ca36bd6aaf3d63618b7`。
   官方 TAT 下载分别验真文件 SHA-256
   `dd26f2cb7687118734b1e96f3f4be9f003edf9ee9ef52273fc189db3acd27ca3` 与
   `33863eb5d378089e8843cadde52aa402d4a1a88d82028362430b7a123da5cca1`；
   收据在各 Cell 的 `receipts/runtime-release-c5923a4e/`，本地归档为
   `/data/tmp/minisandbox-{a01,b01}-runtime-release-c5923a4e-ledger.json`。
   A 卡住的零尝试意图已由新 controller 按 CAS 恢复，随后实际/Ready/desired Node 从 201
   自动串行减少到 156，最新精确 provider acknowledgement 为 157→156；B 已回到四台。
   这是恢复与缩容进展，不是 A 已回低容量的最终证据。正式 release 已按既有契约关闭 reporter
   placement qualification，不能用更新镜像后的旧 receipt 重新开放。低容量收尾、当前 Runtime
   重新绑定资格、strict 10k 和 Router 性能仍未完成，旧失败 cleanup 仍须续接原句柄。
   后续只读采样 `inv-e9d966gx34` 于 06:07:09 UTC 确认 A actual/Ready/desired Node 已降至 85，
   最近 acknowledgement 为 86→85，B 仍为四台。重新审计原 A/B immutable control 后确认两者的
   既有资格模式均为 `initial-cell`；恢复该模式不构成降级，也不代替 autoscaling/strict 10k 证据。
   B 新严格审计 `inv-e9d973gcuv` 只有旧 Bottomless release binding 与旧 Engine HA receipt 两项
   失败，无 warning；FDB、备份、三域拓扑、Engine、Host、static ledger 和 FDB 自动扩容稳态均通过。
   旧 10k 处于 Object cleanup 完成后的 final capacity wait，不再发起流量。经精确 B UID/四台
   admitted Ready Node/Idle/no intent 检查，正式资格任务 `inv-e9d99rguwf` 已启动并确认 RUNNING，
   通过完整 operation lock 与 B UID-CAS hold 串行执行 production-cell Bottomless、Engine HA、fresh
   governance 和正式 qualification publisher。运行中不等于 passed，不允许用旧 receipt 开放 placement。
   该 B 句柄随后终态 SUCCESS/0：48 Actor、6,240 次写入、online checkpoint 不停服，cold wake
   p95=1,210.67 ms、p99/max=4,752.22 ms，sleep/wake 和 cleanup 均通过；独立 Engine HA 的
   1,500 次公共 `/v1` 请求零失败、故障后持久写成功并恢复六副本。Bottomless、Engine HA 和
   activation 文件 SHA 分别为 `a3528ee61847a1e7c88c21b92c874dc455b5bfe44efea572b4914b1cab3703aa`、
   `eb547965ab82813dd4b6b6e98a39a4eff895a56c6d5a18fe79de6b251ead2507`、
   `b5695bd739c574cd15a65807f9d9849296b0b49b7942865f9bbea891cec92b44`；官方传输和本地验证完成。
   现场只读 `inv-e9d9ktg8be` 进一步证明 B spoke 与中央 Hub 均 Ready/readyForPlacement=true，
   release digest 精确绑定当前 runtime，Host 4/4、Idle/no hold、Node 4/4/4/no intent；A 仍在
   47 台串行回收。A 新资格任务 `inv-d9d9jw0nhw` 已启动，首先通过 Kubernetes watch 等待四台
   低容量，之后才取得 operation lock 并采集 fresh strict audit、运行相同资格链。
   B 的 production-cell 通过不替代 strict 10k，也不能提前开放未验证的 A。
   后续只读 `inv-c9da5801w9` 在 06:40:16 UTC 看到 A Node 5/5/5，处于精确 6→5 issued intent。
   原 A 资格句柄随后已报告 `bottomless_started`，说明其四台 exact UID/Ready/Idle preflight
   和 fresh governance 已完成，进入持锁资格阶段。句柄仍 RUNNING，不代表 Bottomless/Engine HA
   已通过；旧 10k final-wait 同样尚未证明终态，不得启动重叠的新 strict 10k。
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

公共入口还需要读取 Worker 的 active Deployment。该 LRU 与 Object placement cache 是两个边界：
namespace cursor 改变或 watch 断线时失效 Deployment cache，不得把旧版本选择永久缓存成 placement。
仅 watch 已同步时，同一 replica、Worker、cursor/generation 的并发冷填充合并为一次只读 Registry GET；新 generation
不得加入旧读取，迟到旧响应不得回填新 cache。合并不延伸到用户 fetch、claim 或写操作，不透明
重试用户副作用。共享读取由 API 生命周期和有界超时拥有，而不是由首个请求拥有；单个请求取消
只撤销自身等待，最后一个等待者离开或 API 关闭才取消共享读取。独立读取与总等待者各自受
`DeploymentCacheCapacity` 限制；已取消但尚未终止的读取继续占用配额，耗尽时返回 retryable 503。
watch 未同步时，后来的请求不得加入较早的 Registry 快照，保持各自独立的有界读取，不回填 cache。

性能模型需要区分有用读取和重复等待：假设有 `R` 个 replica、`W` 个活跃 Worker，一次全局 cursor
失效仍可能造成最多 `R × W` 个有效回填，这是 namespace 失效策略本身的代价。读合并消除同一
代际的并发重复回填，不能消除不同 replica、不同 Worker 或持续发布产生的失效成本。因此扩容
Router 并不自动减少 Registry 工作量。应同时观测实际 Registry GET、共享等待、过载和 in-flight，
再用缓存命中率与 replica 矩阵评估后续是否需要更细的失效协议，不能取消正确性 fence 换取吞吐。

本地真实 HTTP 事件屏障已复现旧路径的 `32 请求 → 32 GET`，读合并回归验证为 `32 请求 → 1 GET`，
随后热请求无 GET。这是机制证据，不是云上吞吐资格，也不是旧万级负载冷降积压的完整根因结论。

该机制已通过 source `723eebaa` 的独立 Go product 发布到北京 C：
[发布收据](../../deploy/tencent/fleet/workers-api/evidence/beijing-deployment-read-release-20261003.json)
绑定 image `sha256:d2e890c531e1979f74dbc83714b365ee11a43050fd45bcd5a1131c83ca95f9d5`；
[Argo 收敛](../../deploy/tencent/fleet/workers-api/evidence/beijing-deployment-read-convergence-20261003.json)
绑定 revision `3021e63d9ffc5f92d1ce173b72d9b39ca21624c1`、十四资源、三节点三 AZ 和原外部 UID。
实际 metrics 为 started/registry=2、shared/overloaded=0、inflight/waiters=0，仅证明新指标接线
和该次观察无积压；无并发命中不能证明云上 32→1 或吞吐改善。后续性能资格必须测量有效
吞吐、重做率、队列年龄与 hot-debt 变化，不能用发布通过、名义副本余量或单元测试取代。

功能回归的超时合同与性能 SLO 分开验证：响应头必须在配置预算后终止等待，流响应体不受
header timeout 或控制请求 timeout 截断。使用真实 HTTP 的取消、flush 与 body-release 事件
建立顺序；共享构建机上的 10 ms timer 不保证线程在 50 ms 内重新获得 CPU。墙钟 p99/吞吐
只能由绑定运行镜像和负载的性能门禁证明，不能靠单元测试的固定 sleep 或缩短等待来证明。

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

探索缩容是独立配置维度，不是 `e2e-fast` 的别名：只将 Host drain 稳定窗口/协调间隔
从生产 `5m/5s` 调整为 `30s/2s`，保留排空取消期限、freshness、三AZ、PDB、UID fencing
与逐台收敛。短窗口可能增加抖动，不承诺Node释放时长，也不能绕过拓扑或资源售罄阻塞。
`runtime/host-drain-profile.py` 提供离线Deployment/受限manifest List转换与单Deployment
检查：探索标记与实际timer必须一致，仅改两个字段及自己的Pod template annotation，
重复/混合配置拒绝。installer源码已接入 `RUNTIME_HOST_DRAIN_PROFILE`，生产默认沿用
原manifest；探索要求整段operation lock、不改变生产运行时配额，返回前检查live配置。
production runtime qualification及strict10k源码入口读取实际Deployment拒绝探索，
不能仅信任caller环境；标准生产release也拒绝探索。真实shell子进程回归使用本地
API double，不能等同云API/Argo收敛资格；尚未发布云上探索配置或改变冻结的原strict10k。
探索通过不替代生产低容量→万活跃→安全缩回的完整证据。
后续开发/修复先以探索模式运行第一道功能与收敛验收，再进入生产参数资格；两类结果
独立标记，模式只在受锁部署流程中切换，不中途改变正在运行的任务。

### Phase 5：资格与演进决策

- 运行百万 dormant Object 元数据和万级 active Object 的分片容量测试；
- 百万 dormant 的公开路径工具使用本地 manifest schema4：每批请求前先持久化精确 Object ID，
  整个 phase 持有同一 manifest 的排他锁，禁止与活跃 population/probe 并发清理，进程退出自动释放。
  成功结果和 confirmation 同事务提交。响应丢失或工具进程被终止后仍按原始 ordinal/probe epoch
  精确清理；cleanup/summary 不重新发布 Worker，配置不匹配在 Code Plane 写入前拒绝。
  清理部分运行的全部已尝试 ID 不等于成功创建目标数量，外层资格仍核对完整 inventory 和状态。
  2026-10-02 真实 HTTP、SQLite 和工具子进程终止回归证明此工具边界，不替代百万云端收据。
- 容量收据必须在完整采样中保持基线 FDB、Host StatefulSet、MachineSet UID 与已收敛 runtime revision。
  同名重建不能拼接成一次成功的扩缩容。采样时间须带时区且严格递增，重复 Cell、重复采样时间、
  非有限或负 active 值不能证明持续容量。峰值按 Cell 分别核对 Ready Host、Ready Machine 与去重后的
  Ready/admitted Node UID，pending/drain 节点不贡献容量；允许普通扩容增加待准入节点及更换 Node UID。
  2026-10-02 本地真实子进程回归已复现旧 verifier 对 UID 替换、未准入节点和时间重放的错误放行。
  新校验只加强离线证据门禁，不改变正在运行的云端请求、3 秒 SLO 或零稳态重试约束。
- 量化 Router p50/p99/p999、cache hit ratio、Registry TPS、跨 Cell RTT 和每请求 CPU；
- Runtime 云构建可显式接入候选源码的 fresh stage：在签发临时 push 权限前验真 source/manifest、
  fork/FDB/toolchain identity、规范四文件 hash 和 static ELF，复制后再次校验并保留原 receipt。
  不读取旧 Runtime、不重标旧产物，不改变 Rust workspace/ABI/资源限制或发布资格。
- Router 性能负载与最终采集共用容量收据校验：八项完整周期门禁必须全部存在且为 JSON true，
  新增检查项也必须为真，active 目标必须是至少10000的整数。空或部分检查表与 truthy 非布尔值
  不构成完整资格；拒绝发生在资源发布、Prometheus 访问和输出创建前。
- query-range 的每个样本时间必须为有限数值、匹配本次窗口/step 网格且在各 series 中严格递增；
  仅允许 transport 的 1 ms 舍入差。重复标签 series、畸形行或错误时间不得当作缺失跳过。
  合法 histogram NaN/Inf 保留 discarded 计数、不补零；每项指标必须在最后请求评估时刻
  有有限样本，跨 Cell RTT 也必须在该时刻有不同 source/target pair。
  每 series 报告最后有限时间；观测均值不是精确事件积分，局部回归不证明 cache/replica 曲线。
- 只有中央 Router 被证明为瓶颈后，才启动 Cell-local Router 下沉；
- 不把压测中发现的单 Cell 上限误写成整个产品上限，横向容量通过增加 Cell 扩展。
- 持续写入与后台队列须分别观察：旧热计划在 Stage 和 Install 都重读当前 head 并核对输入指纹，
  排队期间 head 推进可能使计划失效重排。`cold_workflow_publish` 的事件有序回归分别暂停于
  准入前和 Stage 完成后，通过真实 commit 验证拒绝计数、重新规划及最新页读取。
  准入前暂停仅在 `test-faults` 启用，不在 UDB 事务内阻塞并发 commit；不得为了提升吞吐删除
  fingerprint、生命周期或 PITR/history 校验。局部复现不等于证明云上每个积压任务的根因。
  2026-10-02 本地三条真实存储回归确认两处失效及持续写入饥饿：九个计划分别在准入前被
  新 commit 使其过期，force 耗尽八次重试预算且 root 没有推进，最新页仍正确；这不是云上
  根因已修复的证据，也没有改变当前运行参数。
- 热计划现在绑定不可变已提交前缀：planner 仍按原有 FDB key/byte 预算选择上界，Stage 和
  Install 只读取这段 COMMIT/DELTA；只有证明从未 truncate 的分支才不把后续 head 纳入同一计划。指纹绑定 branch、manifest
  generation、watermark、所选 txid、完整 COMMIT/DELTA 和当前 history/PITR coverage；PIDX
  是可变最新 owner，不属于物化输入，Install 仍以 Serializable 读取、条件清理和原子配额计数
  保留所有未来 owner。新 pin、PITR coverage、生命周期或根 generation 改变仍须拒绝旧证明。
  三条进展回归验证准入前、Stage 后及连续九次真实写入不再无效重排；四条保护回归验证上述
  两个边界的新 fork pin 与 PITR 策略改变仍重排，并保留最新页和 fork 历史读取。这是本地证据，
  不是已发布或 strict10k 已通过；新指纹域使旧未完成计划安全重排，不改变持久数据 schema。
  commit 原子维护新固定宽度索引 `META/truncate_txid`：首次本地提交写零，shrink 写其 txid，
  之后 growth 不清零；缺失或正数的分支保留旧 head fence，非法值 fail closed。truncate 会
  删除或裁剪 SHARD，不能按普通覆盖写处理。Install 在 body preflight 前及最终发布事务内重验
  同一 input identity；检查中 SHARD 消失后，也必须独立证明 stale 才允许重排，真损坏仍报错。
  DELTA 合并按每次 commit 的 EOF 截断，历史 coverage 使用自己的文件尺寸，避免 growth 复活
  旧页。完整十一目标180项回归已通过，包括 staged batch/input-check后的 truncate-grow、
  未知索引、fork历史EOF及坏chunk拒绝；生产非fault check通过，仍不构成云上一万活跃通过。
- 公共 API 的退出不能由首个 listener 返回决定。源码复核发现 SIGTERM 虽在后台发起 Shutdown，
  main 却在 ErrServerClosed 后立即退出，会跳过在途请求排空。真实子进程/TCP 回归已在旧排序下
  重现单/双 listener、accept错误和超时三个门禁失败。修复后公共与内部 listener 同时停止新准入，
  共用原十秒 drain 期限；main 等待全部 Shutdown 和 Serve 终态后才关闭 API。监听失败也须
  排空 peer 并保留原错误，超时则关闭连接，不重放可能已产生副作用的请求。Pod 原50秒 grace
  与30秒preStop保持不变。该本地回归已通过，云上发布与零稳态重试资格仍待原缩容周期结束。
- workerd stage 复用同时验真其嵌入的 Rust SQLite bridge：除了 fork bundle 与固定 stage 文件，
  还以两份真实 offline/locked Cargo metadata 解析客户端、协议及其本地普通/构建依赖，核对源码
  字节、执行位和 workspace/Cargo 配置。只核对 fork commit 不能证明外部路径依赖未变。
  客户端变更必须在容器读取和收据生成前拒绝复用；纯 Engine 或开发依赖变更仍允许复用。
  文件链接同时绑定源码树内目标内容与执行位；目录链接、越界依赖或缺失 graph fail closed，
  不因缓存不存在而自动放宽来源验证。
  直接依赖根绑定已审阅 fork tree，未知新fork即使两份源码相同也不能沿用旧根集合证明；
  必须fresh stage并审阅其bridge合同，不能遗漏新增加的直接路径依赖。
  旧脚本已由真实 Cargo/子进程反例证明错误进入容器读取，新门禁本地通过；云上发布仍未发生。
  完整源码落地门禁须分别检查 shell 的 helper 调用与 helper 的依赖/源码证明，不能继续要求
  已抽出的校验文字留在旧内联位置。该门禁包含不依赖 Cargo 的结构回归，保证空白 builder
  可先落地源码再安装工具链；真实 offline Cargo/变更输入回归仍独立执行，不能互相替代。
  对既有物理编译workspace可显式选择完整输入验真的warm cache：锁定fork commit/tree且working tree
  必须干净，已有source链接不改，完整stage与生产闭包在正式编译recipe前后都必须相同。
  运行recipe及static ELF/hash检查后生成fresh source-bound收据，而不是把旧binary重新贴标签。
  默认空白builder仍按fork身份建立cache；候选manifest、执行位或客户端改变不能借缓存放行。
- builder ACK 故障门禁必须先通过 Hub Kubernetes API 转发并检查 Registry 就绪，再创建业务请求；
  集群内部 DNS 不是 builder endpoint。转发正常及异常结束都关闭，不新增公网服务或改变 ACK 协议。
- 同一门禁的日志解析必须接受现网 tracing 的 ANSI SGR 与 quoted Envoy key，仍严格匹配
  Actor/generation/index；注入前的 DNS 或日志解析失败不构成 ACK 协议结论。
- ACK 门禁的业务动作使用 Guard 6420，私有 reconciliation footprint 使用 API Peer 6421，
  各自转发与就绪检查，不把只存在于 Peer 的检查路由假设为公共 API。
- 2026-10-02 北京 B 的真实 ACK 断线门禁已通过，run `efdbc1c7c33f496ab0593feaed1f7f66`，
  TAT `inv-e9dcgq0tjt` 为 SUCCESS/0，收据 SHA-256 `37e8f31cf9fe8e5a5b7f2b24202c68d98d087f0192932d27fe78a9231f9d0cbe`。
  本次边界是 `after_commit_before_barrier`，Stop side effect 一次、ACK replay/barrier 各一次，
  backlog 为零，Counter 1→2 且 Actor/Cell 身份不变。其他断线边界不能由本收据推定通过。
- C 缺少当前 pinned revision 的 convergence 收据时，使用正式只读 recertify 恢复 CAS 基线；
  serving 必须绑定十四项 tracked resource、两条 private endpoint 的安全策略、immutable Secret
  以及四个外置 Cell identity/serving route ConfigMap 的 UID 和路由摘要。只读重验不构成压力、
  业务准入或历史 self-heal 资格；漂移失败不得通过修改现网或手工拼收据来绕过。
- immutable 身份路由只允许五个身份字段，或额外包含完整四个资格审计 SHA-256 字段；未知字段、
  部分审计摘要、畸形摘要及 UID 改变都拒绝。审计字段不参与网络寻址，原 immutable UID 保护其原始内容。
- 2026-10-02 C 正式发布 TAT `inv-a9deatgjx5` SUCCESS/0，Argo revision
  `10b5ef6eeac98a1c9844df0e5fae023a708816a8`，Workers API 镜像
  `sha256:2f7b6e9b4687f566163b4ee6b5ad7eb6275ac413c903b578e887163ede0e0d2a`。
  发布 convergence 摘要 `57207003ec5f365a94628d2c56feee114bff0f9b9164af37e74af4b00c42b602`，
  保留 Deployment、两条 CLB、Secret 的 UID/VIP 与 A/B Application，三副本三节点三 AZ，自愈通过。
  后置独立只读重验 `inv-d9dedt0wte` SUCCESS/0，收据摘要
  `c0b636478ee294319390cba719aa2cadcd3522bf5e60604b10d69ac650706bf8`，十四资源和四路由一致。
  该证据只完成 C 发布边界，不替代随后启动的万级低容量扩缩容资格。

## 必须固化的测试矩阵

公共 API 的真实在途排空由独立 `load/workers-api-business-drain/` 门禁验证。它保持生产
30 秒 preStop、50 秒 grace 和十秒 HTTP drain，先接收长流前半段，再用 UID precondition
正常删除一个 API Pod。独立 admission 转发必须观察到容器拒绝新连接，而原长流仍未结束；
随后须完整接收固定 128 KiB 内容、零重试、恢复三个 Ready API 节点，并精确清理临时
stateless Worker。公共 CLB 同时接收独立快速业务请求。readyz HA 收据不能替代这个门禁；
本地回归与工具实现也不能替代实际云上通过收据。
HTTP 的 fixed-length 与 chunked framing 均合法，但必须核验固定业务内容、完整 EOF 和
listener-before-completion；header 本身不能作为数据完整性或排空成功的证据。
北京公共 API 在途排空的
[2026-10-03 收据](../../deploy/tencent/fleet/load/workers-api-business-drain/evidence/beijing-20261003.json)
绑定工具源码 `9f6c745c` 与已发布 API `28db6ffa`：原流在 listener 停止后继续 4.874 秒、
完整 128 KiB、零重试；替换期间 138 次公共业务请求零失败，恢复三个 Ready API 节点并完成
临时 Worker 清理。该证据只证明这个 API 故障边界，不证明内部 Router 或万级性能。

同日读合并发布后的
[新镜像业务排空收据](../../deploy/tencent/fleet/load/workers-api-business-drain/evidence/beijing-deployment-read-20261003.json)
绑定 source `723eebaa` 与 API `d2e890c5`：正常 UID 删除替换期间仍有 138 次公共业务请求
零失败，全部 145 请求零失败；原长流在 listener 停止后继续 4.912 秒并完整结束，零重试。
恢复三个 Ready 节点，临时 Worker DELETE 204，原 Deployment/HPA UID 与配置保持。
这是当前发布的业务正确性证据，仍不是 Router 并发读合并或整体大规模性能证明。

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

Pod 故障注入必须通过 Kubernetes DELETE 的 UID precondition 绑定已观察的目标，不能仅按名称
删除。正常 termination 不覆盖 workload 的 grace period/preStop。UID 冲突或 ACK 身份不符时
门禁立即停止，不重新选另一台删除。恢复使用同一个 Pod-list snapshot，必须证明目标旧 UID
已消失、所有未选中 peer 的旧 UID 保留、恰好一个新 Ready UID 恢复原副本下限；无关 peer
被替换不能算作目标恢复。该 harness 约束的本地回归不代替真实 Cell 网络和性能资格。

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
workers_api_deployment_reads_total{namespace,result=started|registry|shared|overloaded}
workers_api_deployment_read_group{namespace,state=inflight|waiters}

durable_object_wake_seconds{namespace,pool}
durable_object_active{namespace,pool}
```

Grafana 分开呈现 stateless execution、Object Router、durable runtime 和 Registry/FDB。扩容决策只
消费对应执行面的指标；跨 Cell QPS、失败率和 RTT 用 bounded Cell label 观察。

2026-10-04 的 producer 复核仍不能证明上述观测合同全部完成。现有 stateless exporter 提供
`rivet_stateless_queued`、`rivet_stateless_in_flight` 及代码缓存计数；
`rivet_stateless_code_cache_memory_entries` 表示 Host 代码缓存条目，不是 workerd live isolate
数量，不能直接映射成 `worker_isolates`。Pegboard 的 `pegboard_actor_start_duration` 记录
allocation 到 connectable，包含协调与网络时间，且未区分首次启动和从休眠恢复，不能单独
证明 `durable_object_wake_seconds`。生产源码和配置的有界检索尚未发现上述 isolate/cold-start/
wake 三项语义的完整 producer。必须补真实执行生命周期观测、bounded 标签和语义回归后
再关闭此项；不以改名、代码 cache miss 或局部资格的 wake histogram 冒充平台持续观测。
这不是降低原观测要求，也不否定已有 queue/active 指标；当前发布或万级验收通过仍不能
自动证明完整设计已经完成。

### 性能劣化的模型与验收口径

分别建模交互请求、placement/唤醒和持久化后台，不能以一个总 CPU 指标替代。对每个阶段
记录到达率 `λ`、实际服务时间 `S`、有效并行度 `c`、排队时间和无效工作比例。粗略容量模型
`ρ = λ × E[S] / c` 只在工作粒度一致、近似稳态时用于定位；真实串行热点、共享物理 CPU、
FDB 冲突或 COS 限流会令有效 `c` 小于副本数。提高副本数却增加同一真值上的争用，不算扩容成功。

冷降必须测量有效工作，而不是任务启动量：

```text
effective_reclaim_bytes/s
    = completed_attempts/s × successful_fraction × mean_reclaimed_bytes_per_success
hot_debt_change
    = newly_retained_authoritative_bytes - authority_released - branch_gc_released
```

这里的 bytes 都是平台逻辑账本口径，不是 COS 计费大小；upload/publish 不等于已经从 FDB
释放 authority。重复覆盖、冷热 cache 和 metadata 必须分开，不能把 guest 的全部写入字节
直接当作新增 hot debt。`sqlite_compaction_jobs_total` 的 result 与
`sqlite_compaction_bytes_total{operation="reclaim_fdb"}` 联合观察有效工作；
`sqlite_cold_storage_accounting_bytes{class="fdb_authoritative"}` 观察账本趋势。
Cell 账本由多个 Engine 重复采样时不能对 replica 求和；选取同一时段的有效 Cell 观察并保留采样误差。
在途 batch 的 backlog gauge 不是整条 durable queue 的长度，完成者 wait histogram 也不能
证明尚未获得 permit 的最长等待年龄。缺少这些观测时应明确证据缺口，不捏造队列已经收敛。

设计修正优先消除无效工作和错误反馈：共享 generation 内的重复读取；持续 append 使旧
head-fenced 冷降计划反复失效；大量 Envoy 一次加入带来的协调风暴；休眠对象被周期轮询。
持续 append 可以使用已封闭输入前缀，但 generation、truncate、PITR/history、原子 cold publish
和 serializable 条件清理仍是正确性 fence。交互与后台的许可分开不等于 FDB/CPU 隔离；后台
并发必须保持有界并检查交互尾延迟，不能把每个 Engine 的独立限额误当作 Cell 总预算。

验收固定 Version 数、请求到达/活跃/唤醒模式、缓存命中率、代码/镜像和物理容量，对比成功
吞吐、p95/p99、排队/重做、事务冲突、实际 publish/reclaim、hot-debt 导数与扩缩容轨迹。
只有对应窗口有效服务追上负载、积压不持续增长且原零重试/身份/持久性门禁不放宽，才可称
性能改进。该模型是实验与设计约束，不是当前万级/百万资格已经通过的证据。

性能回归必须留下可验证的设计结论，而不是把每轮失败转换成更大的配额。每个候选原因
按「触发负载 → 单位有效工作成本 → 共享瓶颈 → 排队/重做反馈 → 修正 → 对照证据」记录。
源码确定性缺陷、窗口相关性与首错请求的因果链是三个证据等级，不能互相替代。
规模增长时至少分别检查以下增长项：

- dormant 基数带来的目录/缓存驻留量；历史访问不能使单 API 进程无限增长。
- active 数与业务到达率；10,000 个对象每十秒一次持久交互，目标是约 1,000 次/秒，
  不是一万条连接或无写入的 keepalive。
- 按对象周期触发的维护需求 `N_active / T`、每 job 的输入/coverage/shard 数，以及失效
  重做和 durable replay；增加 Engine 不得同时无约束地增加 Cell 的后台需求。
- burst 与新增容量的供给延迟；可用 headroom 应覆盖供给期间的新需求，并计入镜像/节点
  准入时间。将 warmup 拉长不能替代三秒创建 SLO。
- 在线、构建和观测面的物理资源交集；HPA 的控制输入受故障影响时，扩副本不能修复信号。

整改先降低重复扫描、串行等待和无效重做，再隔离必要资源、限定总预算，最后校准扩容。
任何批处理/缓存/并行化都必须保留 generation、FDB ACK 和失效恢复语义；不能把丢计量、
丢持久信号、透明重试有副作用请求或延长超时当作性能优化。对照以同样负载与资源身份
测单位读写/事务成本、实际到达/成功率、队列年龄、p99、有效维护和债务斜率。

成本按资源向量分开，而不是把所有 job 当成同一种服务：每个成功交互/唤醒/维护单位的
point-read 数、range bytes、transaction attempts、fold 输入/输出页、COS requests 和 CPU
分别记录。对资源 r，需求近似为各类实际到达率乘单位有效工作成本之和，加后台有效服务
和无效重做的真实需求；供给则是同一窗口实测可用吞吐，不是副本数。该向量用于对照，
不新增每请求争抢的全局 FDB key。缺失的计数保持 unknown，不拿总延迟反推出读写次数。

| 已确认的结构问题 | 应改变的模型项 | 必须另验的结果 |
|---|---|---|
| adapter 将独立点读串行等待 | 请求关键路径长度；总 GET 数不因此减少 | 相同负载的尾延迟与 FDB 总 read demand |
| 多 coverage 重复折叠共同前缀 | fold 输入访问量；输出复制仍保留 | 单位有效维护成本、实际 reclaim/debt 趋势 |
| 每 Engine 的维护许可叠加 | Cell 总后台并发及重做预算 | Engine 扩容后前台尾延迟不反向恶化 |
| 构建与控制节点共盘 | 在线资源 reserve 与供给信号可用性 | 实际隔离、custom metric 连续性及新节点落位延迟 |

后续增长门禁既检查尾延迟，也检查单位有效工作成本是否随 active 数、历史长度或副本数
非预期增长。三秒创建还要求已有可用 headroom 覆盖实际节点/镜像准入供给期；HPA
从不足容量开始追赶不等于能承诺每次突发三秒内完成。上述判据不是当前已测容量数字。

Router binding 负载工具以固定时钟生成到达计划，分别记录计划到实际 dispatch、dispatch
到 response、计划到 response 的时延。客户端迟到和线程调度时间不能从端到端数字中消失；
所有已提交请求仍只执行一次，达到有界 in-flight 上限即失败，不改成慢速闭环掩盖过载。
请求计划窗口与等待尾部响应的 drain 窗口分开记录。
实际 dispatch 超出计划窗口时，即使所有响应成功，也以 `load_generator_deadline` 拒绝该
负载资格；不能把尾部补发算成原窗口达到目标速率。Prometheus 使用 `[5m]` 时，第一评估
时刻至少为计划窗口开始后五分钟，最后评估不得超过计划窗口结束，因此准备和尾部等待
不能混入 steady-load 曲线。五分钟负载可能只提供一个完整滚动评估；更长曲线需更长负载，
不能用准备阶段补足点数。客户端 latency histogram 包含所有成功请求的完整尾部，仍不是
某个服务端阶段的纯 execution latency。滚动速率仍是采样估计，不作为精确事件总账。

固定 Object 轮询不能保证 Router cache 为 1%、50% 或 99% 命中。命中取决于每副本的
LRU 容量、idle TTL、流量分配与 reuse distance；新的 Object 还会混入 claim/wake 成本。
完整 cache/replica 矩阵仍须独立工作集/流量形状和实际 cache 指标验证，不能把拟定的热 key
比例写成命中率或将这次工具门禁等同于整个性能矩阵完成。

有界缓存的内存模型还要拆成 `entries * (key + binding + index)`、有界 miss table 的
在途状态，以及 HTTP body/其他 API cache/native allocator。单纯限制 entries 不证明
产品 RSS 上限。`TestRouterMillionKeyChurn` 用固定 64-byte ID payload 实际访问生产
Router 的一百万不同 key，冻结时钟排除 TTL 对淘汰的掩盖；在 131,072 和 1,000,000
访问后强制 GC 比较保留 heap，并核对 LRU、miss 表、命中/淘汰与 Worker exact 删除。
它使用单独的 fixture 内存增长门禁，不将该阈值作为部署预算；这项本地组件证明不替代
真实 binding payload、整个 API RSS、百万 dormant 公共路径与跨 Cell 云端资格。

容量单位还须包括工作负载形状，不能只报“多少 Agent”。当前 strict10k fixture 的每次
heartbeat 都读取去重记录，并用 `storage.put()` 更新 state 和新的 operation 结果；
10,000 个 Object、十秒周期的目标到达率约为 1,000 次持久交互/秒，而不是 1,000 次纯
内存 keepalive。对象内最多一个在途 heartbeat，迟到请求会降低实际发起率，因此必须同时
报告目标节拍、实际 attempts/s、成功/s 和延迟，不能把无失败的慢发起解释为达到目标吞吐。
operation 记录持续增加，不是固定尺寸覆盖；用户 payload、SQLite 页写放大与新增权威 hot
bytes 也不是同一单位。不得为通过资格偷偷改成无写 heartbeat 或删除去重记录。

| 压力来源 | 应扩大/控制的资源 | 不应推断 |
|---|---|---|
| 活跃 Object 的执行/RSS | durable Host、已准入节点与对象装箱 | Host 扩容能提高同一 FDB 的写吞吐 |
| Router miss/Deployment 失效 | 有界回填合并、缓存与 Router 容量 | 增加 Router 副本必然减少 Registry 请求 |
| durable commit 与后台维护 | Cell FDB 延迟预算、有效维护吞吐和并发 | Engine Ready/CPU 空闲表示事务无争用 |
| COS 限流或保留期限等待 | 有界 I/O 并发/退避、明确资格时间边界 | 增加 Host 或删正确性 fence 能加速安全回收 |

每个 Engine 的 refresh/compaction permit 是本地资源，不是 Cell-wide permit：固定六 Engine
时，8/2 配置对应名义总上限 48/12，实际有效并行度仍受共享 FDB/COS 和输入失效约束。
未来 Engine 水平扩容必须先保持并重新校准 Cell 总维护预算，不能让副本数自动放大后台负载。
不因此引入一个每请求争抢的全局 FDB semaphore；预算分配和持久状态正确性是不同所有权。

用同一时间窗口区分三个可证伪判断：等待队列持续增长且有效服务满载才支持服务容量不足；
许可空闲、债务不降并有 exact retryable job 时应检查重排/策略期限；新副本增加后 GET、
失效计划或事务冲突增加而成功吞吐不升，则是工作放大而非单纯容量不足。累计 counter、
一次空队列或平均服务时间均不足以作此判断。稳定运营需要有效回收追上新增权威 debt，且
保留时间内和突发期间的债务峰值、最老等待与交互尾延迟有界；最终必须由固定负载与镜像
的真实时间序列验证，不用提高超时、重试或减少活跃对象来替代。

容量负载 observer 将旧八个容量/压力查询与上述后台信号合成一个每 Cell 的有界 instant
vector。保留请求/样本时间、完整 query、operation/result/class 和缺失/非有限状态；完成任务、
成功 bytes/objects、duration sum/count 使用五分钟 `rate`，必须先在原 counter 上求 rate 再聚合。
重复 Cell 账本同时保留 min/max，反映采样分歧，不把 Engine 数量乘进存储账本。响应限制
1 MiB/256 行，五秒 HTTP 超时、无自动重试；观察程序不改变产品并发或维护周期。

冷降时间进一步拆为 `保留/策略等待 + 排队 + 实际服务 + 计划失效后的重排等待`。
2026-10-03 A 的实际 production-cell gate 48/48 exact cold、冷唤醒及 Engine HA 通过，但全部
冷态等待约 973 秒。中途 29 个对象暂留 hot SHARD，同时观察到 compaction inflight/waiters
均为零、累计 reclaim retryable 为 29；这不能单凭相关性证明完整根因。当前 manager 对 exact
成功回收立即续下一有界批，对失效回收仍使用正常维护周期；生产默认 600 秒并按分支错峰为
约 300～900 秒。需要用 exact job/时间顺序与真实存储回归验证这项等待是否贡献尾延迟，再
考虑有界重排退避。不能缩短保留期限、取消 fingerprint、盲目提高并发，或将所有 dormancy
对象重新变成周期轮询。A 最后发布 block 是收据名称与发现规则不一致，与上述冷降时间是
两个不同问题；保留原失败决策，仅恢复资格发布，不重复执行已通过的 fault gate。

2026-10-03 同一 Runtime `072e504b` / digest `6e4d982e` 的 A/B 原始 gate 已归档到
`runtime/evidence/beijing-prefix-072e504b-{a01,b01}-{bottomless,engine-ha}-20261003.json`。
原字节 SHA 与下载端一致；Bottomless 使用 production-cell verifier，HA 核对原生成器的
canonical hash、故障 UID 消失、版本不变、流量窗口内注入与清理条件。两 Cell 均为 48 对象
exact cold；A/B 冷态等待约 973/964 秒，冷唤醒 p95 约 956/1,072 ms；各 HA 1,500 次
公共请求、零失败。它们只证明这些具体门禁，不证明万对象服务容量或 Router 吞吐。

万对象启动还必须检查当时的 placement 真值。首个 preflight run
`e479f1a64f1e4d109ac8940d75c05999` 遇到 B `readyForPlacement=false` 而退出，未创建负载
目录；不能将 TAT 服务提交成功视为资格成功。发布 activation 与 Cell report/controller 的
收敛是不同步骤，保留失败快照并等待控制器自然恢复，不手工设置 readiness。
该失败快照的具体原因是 `CapacityEvidenceMissing`：报告新鲜但缺少 Prometheus-backed
容量证据，健康与 FDB 条件正常。后续只读 `inv-e9e0300ee9` 确认新证据到达后 PlacementReady
自然恢复；不能将此暂态误归因于存储数据丢失，仍需监测容量证据的缺失频率与尾延迟。
TAT 命令最长 24 小时，完整自然缩容门禁允许等待 36 小时；因此该资格用独立、确定 run ID
的 systemd 服务承载原 runner，保留整体 operation lock 和退出状态，TAT 仅提交/只读查询。
不得把外层启动 SUCCESS 或观察期间短暂 Ready 当作最终 strict receipt 通过。

后续 run `d3a163511fd849bf9a466553e4ab4f48` 已从 A/B 各四 Host 起步。首个约 270 秒的
progress 为 384 ready、5,275 active interactions 成功、零 terminal failure，但 warmup
容量背压重试 2,418 次，就绪最大约 78 秒；不能报告为全程零重试或三秒创建达标。
相邻容量样本 A/B 各六 Ready Host，desired 已为 10/11；后台 refresh/compaction
inflight/waiters 为零。这支持先排查新 Host 准入/容量等待，但不是完整因果或稳态证明。
最终 steady-state 的零重试/三秒要求不变，低容量 warmup 与 steady-state 分别报告。

生产创建 SLO 的容量模型还要包含供给时延：保留可用槽位至少覆盖
`incoming_create_rate × node_admission_p99 + expected_wake_burst`，并留安全余量。
这里的槽位必须来自真实 admitted/Ready/非 drain Host，不计 Pending 或 desired 副本；
节点启动、精确镜像探测和 Host 注册耗时计入供给时延。只有水位阈值而没有这一余量，低
容量突发时必然先背压；单靠放宽重试不会改善用户创建 SLO。该公式是容量规划约束，当前
未实现预测扩容，也不能用本次 warmup 的容许重试替代正式创建 SLO。

同一 run 的最终资格已失败，原字节收据保留在
`load/ten-thousand-active/evidence/`。9,194 ready、约 212 万 active attempts 后，首个错误是
初始化 `502 indeterminate_result`；之后 2,643 条 `code=20` 是全局取消扇出，不能当作独立
网络故障。9,226 个 scheduled Object 全部精确删除、清理零 retry，A/B 自然缩回各四个
admitted/Ready 节点。自动扩容、稳定身份、安全 drain 与最终低容量检查通过；10k sustained、
active capacity 和 load verdict 没通过，不能继续生成 Router performance 资格。

最后故障前样本的 A/B compaction 为 12/12 in-flight、1,360/1,102 waiters，B UDB pending
达 3,989。故障前历史范围查询显示 Cell 汇总 Engine CPU 峰值约 10.6/10.8 cores，B UDB
operation p99 约 0.988 秒、workflow-history transaction mean 约 1.007 秒；汇总 CPU 不支持
直接复用上一轮总 CPU 饱和的结论，仍不能排除单 Pod 饱和。最后约 27 分钟的采样窗口有效
reclaim 为零，authority bytes 增长约 A 1.35/B 1.41 GB；live pins/retention 也可合法解释
reclaim 延后。下一步必须区分 hot fold 的有效/失效工作、history replay 字节、FDB 重试和
cold eligibility，不能仅调 permit、Host 数或超时。原始首因 transport log 没保留在此次
有界 current-Pod 选择中，不能用之后的取消日志补造首因；压力相关性不是完整因果证明。

进一步只读历史查询 `inv-c9e9u20q2x` 覆盖首错前的 20:07--20:27 UTC、30 秒步长。
原始 `work-amplification.json` 为 718,367 bytes，SHA-256
`e73676dd1ad9ddd37278a243a8f9d3ebbab63eafac3549b6fb01a818a2b879ce`，保存在同一
builder evidence 目录并经 COS 验真下载。末个五分钟窗口 A/B manager 规划读取约
23.16/24.19 MB/s，hot stage 另读 9.22/7.00 MB/s；manager 每完成一笔 transaction 对应
约 605/634 KB 读取，平均 attempts 为 1.460/1.453。这不是 business payload 的写放大倍数，
也不是全部 FDB I/O，但证明维护规划已是主要读取成本之一。逐 Pod 一分钟 CPU 峰值最高
约 A 2.09/B 2.34 cores，不支持仅凭汇总低 CPU 就继续盲加 Engine。

同一末窗口 stage activity 完成率约 A 39.13/B 35.80 attempts/s，平均总耗时
27.77/28.26 秒；install 平均约 26.40/26.33 秒。现有 `gasoline_activity_duration` 将成功、
失败、超时都记到空 error 标签，且在 history 写入后才观察，因此这些完成率不是成功 fold
吞吐，不能回推有多少 timeout。`run_activity()` 的默认 30 秒 timeout 包住整个
`Activity::run()`，而 Depot 在其中等待 semaphore。真实 RocksDB、生产 ActivityCtx 和零容量
semaphore 的回归已证明：尚未获得 admission、数据工作完全没有开始，就可以写入一次持久
activity timeout。此机制提供了排队超时和 replay 放大的可证伪解释，仍不是上述首个 502 的
完整归因。

新增 `gasoline_activity_attempt_duration{workflow_name,activity_name,result}` 使用固定
`succeeded|error|timeout` 三值，观察返回或超时的执行尝试，在 history write 前记录。
它不记录被外层取消但没有返回的尝试，不表示 workflow commit，也不把业务返回的
`CompactionJobStatus::Retryable` 当作成功 fold。成功 activity history 的生产 replay 不再计一次
execution attempt。历史指标保留，持久输出、timeout、重试和 generation fence 均不因此改变。
当前只完成源码和真实存储验证，没有发布新 Runtime 或把历史窗口重新分类。

下一修正的模型要分离三个时间和两种服务率：

```text
T_attempt = T_admission_wait + T_execute
T_workflow = T_attempt + T_history_commit + T_replay/backoff
attempt_service_rate != useful_fold/publish/reclaim_service_rate
```

许可数约束正在执行的工作，不约束已经 leased、携带历史和 activity retry budget 的等待者。
只减 permit 会增大队列等待；若等待仍消耗 execution timeout，就可能变成
`queue -> timeout -> history/replay reads -> FDB latency -> slower queue` 正反馈。
稳定性必须用每种工作类型的有效 service time、有效成功率、实际输入 bytes 和队列年龄判断，
不能拿约 28 秒的含排队时间除以 12 个执行许可来计算执行吞吐，也不能认为约 40 attempts/s
已处理完约 40 个有效 job。

在修改调度前需要固化如下边界，而不是直接提高 timeout 或无界等待：

1. admission 等待、执行失败与 FDB commit/replay 失败分开；排队不能无意义地耗尽数据 job
   的失败预算，但等待本身仍须有界、可取消且恢复后不丢 exact job。
2. 后台超出执行预算时，未运行工作应保留 durable identity 和明确 due/lease 所有权。
   不能返回假成功、丢信号、轮询所有 dormant Object 或争抢一个全局每请求 FDB 锁。
3. 同一 branch 的 dirty wake 合并，并检查 active job 已占用时是否仍反复完整规划输入。
   对 DELTA 读取优化须保留事务/字节预算和 exact committed prefix；stage/install 的 lifecycle、
   truncate、PITR/pin、原子 publication 与条件 PIDX 清理校验不能去掉。
4. 各阶段报告 attempt result 和有效 output，先证明 timeout/replan 放大下降、前台尾延迟恢复、
   hot debt 有界，再重跑相同 strict10k。以下准入修正目前只有源码和本地回归，不代表线上已修复。

### Active job 期间的规划成本

manager 先处理当前 signal 批次，再选择 refresh 模式。旧路径即使 branch 已有 active job，
仍读取完整的 committed DELTA prefix、冷态与 reclaim 输入，然后在 dispatch 阶段丢弃不能运行的
计划。排队越长，同一前缀就可能被越多次重复读取，额外消耗 FDB 服务能力。这是源码中可确定的
无效工作，不等于已证明它独自造成历史首个 502。

仅 active-job 分支使用 Gasoline version check 记录新的活动序列，普通规划不增加版本事务：

- 无 active job：保留完整 `RefreshManager` 和所有规划校验。
- 任意 hot/cold/reclaim job active：运行 `ObserveActiveManager`，只读取 branch、head、dirty
  和固定分片 pin-count index。元数据读取使用同一 UDB transaction；没有 DELTA、SHARD 或
  reclaim 扫描，也不执行 dirty 清除、stage cleanup 或 publication。
- 观察结果显式为 `planning_deferred=true`。缺少计划不代表无工作，不能结束 force request、
  派发另一份共享 generation 的计划或使 manager quiescent；branch 非 live 仍立即进入停止流程。
- 既有 cold/reclaim fallback deadline 保留并按到期事件重新安排。精确完成信号仍由 companion
  的持久 signal/replay 发送；处理完最后一个 active job 后，下一 refresh 恢复完整规划。
- 已记录的完整 refresh 仍回放原 activity；不能直接删掉旧历史中的步骤。version check 也有
  小额持久事务成本，不能将减少 DELTA bytes 自动换算为整条请求吞吐增益。

该修正不改变数据 job 的 lifecycle、root generation、truncate、PITR/history、publication 或
条件 PIDX 清理 fence。它不解决 admission queue 消耗 execution timeout 的另一条反馈链，也
不能使已耗尽重试预算的 companion 自动恢复。实际发布后仍须测量规划读字节、有效 fold、
queue timeout、交互尾延迟和 hot-debt 趋势，并通过原 strict10k，才能宣称万级性能整改完成。

### 有界准入与性能稳定性模型

新的显式 activity admission 与实际执行分开计时。执行仍使用原 `TIMEOUT` 和失败预算；
普通、未声明 admission 的 activity 保留原执行路径。一次完成的 history replay 不再排队。

- Depot 每进程仍只有 refresh 与 compaction 两条独立执行 lane，不扩大原 8/2 执行许可。
  每 lane 最多 `clamp(8 * permits, 8, 64)` 个等待槽；生产对应 64/16，而不是随 Object 数增长。
- 已接受的等待按 Tokio semaphore FIFO 排序。等待最多 30 秒，worker stop 立即取消准入并
  返回已有的 eviction 语义。队满或等待到期不执行数据工作，不写 activity failure event。
- 未执行的工作返回 admission deferral。生产 workflow error handler 通过 exact lease 提交
  60--120 秒的错峰 wake deadline 并释放 lease。原 signal/history/input 是真值，不新增 job、
  不发送假完成，不清 dirty，也不增加 `MAX_RETRIES` 的执行失败计数。
- permit 只覆盖执行，成功、失败、timeout 或 cancellation 均释放；history commit 不占许可。
  直接调用宏生成的 `Activity::run` 也先准入，不能因使用工作流外入口而无意绕过限制。
- 新 `gasoline_activity_admission_duration` 仅使用固定 `ready|complete|deferred|error|evicted`
  结果。显式 admission 不再进入 attempt execution histogram。旧 Runtime 的含排队数据
  不得与新执行时间直接拼接比较；正常返回 retryable status 仍不代表有效 fold。

这切断了“未执行却消耗失败预算”的反馈，但不会凭空增加存储吞吐。稳定性按工作类型而非
仅按 active Object 数判断：

```text
rho_lane = sum_k(offered_execution_demand_k * mean(actual_execution_seconds_k)) / lane_permits
useful_service_rate_k = successful_fold_or_publish_k / observation_seconds
d(hot_debt_bytes)/dt = authoritative_hot_bytes_in - safely_reclaimed_hot_bytes_out
```

`offered_execution_demand` 包括新工作、必要执行重试和实际失效重做；同一 job 的准入延期
不算新工作。共享 compaction lane 的 stage/install/upload/publish/reclaim 成本必须相加，
不能给每种 activity 各自算一份完整许可。仅测已获准执行率会被 admission 截断，不能替代
offered demand；实际需求率与有效进度目前还须在正式负载中补齐。

`rho_lane >= 1` 的持续输入仍会积压，必须减少每份有效工作的扫描/重做成本、合并工作或增加
经证据校准的资源；改变超时不能让它稳定。等待槽的 FIFO 只约束已接受队列，不承诺持续过载
时所有 deferred workflow 的全球顺序或无饥饿。延期仍有 due-index/history replay 成本，
约随 `pending_jobs / deferral_interval` 增长，不是常数：一分钟下限避免逐秒 polling，但
并不证明百万待办的成本可忽略。错峰周期和等待槽数是首轮保守策略，尚不是容量校准结论。

后续正式 release 与原 strict10k 必须同时验证：准入 deferral/等待年龄、真实 execute 分布、
有效 fold/publish/reclaim 率、规划和 replay 的 FDB 读字节、前台 p99 及 hot debt 的斜率。
如果 deferral 降低错误却使 debt 持续增长，仍判性能门禁失败。暂停的工作也可能延后 branch
完成/停止信号处理；不得把 bounded delay 描述为立即完成或丢弃 exact job。

统一 capacity trace 的只读诊断查询同时保留九类显式活动的 admission/execution sum/count
速率，以及 full refresh、active observation、hot stage 三类固定 transaction 的 read bytes、
attempt sum/count。所有 counter 先逐 series rate，再按有界活动/结果或 transaction 聚合；
不增加查询次数、Actor 标签或数据库扫描。旧 Runtime 缺失新指标时明确标为 unknown，不能
回退到包含排队的旧 duration，也不能将新 execution `succeeded` 当成有效 fold。
这些数据足以比较已完成工作的扫描和重试成本，却仍不覆盖全部 history replay、offered
demand 或未完成工作的最长等待；缺项不能被均值、CPU 空闲或 HTTP 错误减少代替。

对应离线实现为 `fleet/load/ten-thousand-active/analyze_pressure.py`，只读取不可变 capacity
trace，输出固定维度、原字节 SHA 和显式非资格诊断。可按 observation 时间选择负载窗口，
避免把失败后的 cleanup 回收混入稳定服务结论；滚动五分钟 rate 仍不等于精确区间事件数。
同窗规划 bytes/完成事务、attempts/完成事务、已完成准入等待和分结果执行时间分别报告；
ledger 取副本 min/max，增长上下界使用实际 query 时间。最新缺失保持 unknown，不回退；
资源 UID/Host revision 变化拒绝跨身份比较，正常 Node 增加不视为身份漂移。

计量单位须按实际 producer，而不是只看 Prometheus 名称或 HELP。现有 cold upload/publish
bytes 取计划中 hot shard 的尺寸之和，items 取输出 cold ref count；reclaim bytes 则取
实际删除的 FDB value bytes、items 为 key count。离线 schema v2 显式携带这些单位，
不能将三者都叫 COS objects，也不能从计划 bytes/ref 推导 COS 对象填充率、wire bytes
或唯一 PUT 次数。一次成功 activity 的重放重执行仍可能重复计入计数，实际 ledger 和
provider inventory 才能证明净存量；这些计数不能直接相减当作同单位的 hot-debt 收支。

新 run 55b55875 的[早期非资格诊断](../../deploy/tencent/fleet/load/ten-thousand-active/evidence/55b55875-pressure-early-20261003.json)
绑定固定前缀原字节 SHA：03:35--03:48 UTC 每 Cell 44 样本，资源身份完整。
阶段约 1.6k active/Cell，manager waiter 峰值零，compaction waiter 峰值 0/1；authority
观察增长约各 0.20--0.22 MB/s，末端安全 reclaim 为零。该观察说明当前无明显维护准入
排队，却不足以判断 pin/retention 还是服务吞吐限制，更不证明高水位稳定或旧 502 根因。
实际 producer 契约与 v2 17 项回归只证明计量边界，不能替代严格容量/自然缩容资格。

#### 高水位失败与工作成本模型（2026-10-03）

Runtime 59 的同一 run 55b55875 最终在 warmup 9,127 ready / 9,111 proven、
2,086,955 successful active interactions 后停止，未进入正式三秒创建样本。
[原始 load receipt](../../deploy/tencent/fleet/load/ten-thousand-active/evidence/55b55875-load-receipt-20261003.json)
为 failed：04:36:35.187 UTC 的 initialize index 9086 返回一次 502
indeterminate_result；随后 2,043 个 code=20 是全局取消。普通请求 retry 仍零。
原 supervisor 随后完成 exact cleanup 和 7,801 秒自然 drain：最终两 Cell 各四 Host/
Machine Ready、active 零，但 strict receipt 仍 failed，万活跃及正式三秒样本未通过。
原终态观察及 receipt 身份见上述 evidence README；扩缩容通过不等于容量负载通过。

[04:15--04:29 非资格窗口](../../deploy/tencent/fleet/load/ten-thousand-active/evidence/55b55875-pressure-late-20261003.json)
各 Cell 41 样本：A/B compaction 都达到 12 in-flight，waiter 峰值 89/88。
末端 stage 成功执行均值 236/282 ms，完成率 37.86/34.76 per second。
[故障前窗口](../../deploy/tencent/fleet/load/ten-thousand-active/evidence/55b55875-pressure-prefailure-20261003.json)
04:25--04:36:35.187 各 32 样本，末次实际 query 均早于首错：A/B pending 峰值
4,373/717，stage 均值升至 856/466 ms、完成率降为 11.87/22.75 per second；
full refresh read bytes/完成事务升至约 443 KB，attempt ratio 为 1.484/1.391。
observed authority 斜率约各 0.92--1.02 MB/s，不能称为全部可回收债务。
有界等待者比旧失败显著少，但本轮仍失败，不能将队列有界当作容量整改通过。

额外 bounded transport/cost 原字节证据绑定 SHA
`a831e7c8439a8714977e72a7e33c5cbd296ab49d47e1685e0d9dca7ce1ee28f9`，路径和
复算方式见 evidence README。首个 API warning 在 04:36:35.186453032 UTC：连接和
发送各约 2 ms，25,002 ms 后 awaiting_response_headers 超时；其余匹配 warning 为
取消。C Workers API 已同 UID/image 自动扩到 13 Ready，非固定三副本。A/B 同窗每
Engine 一分钟 CPU 峰值不超过约 1.82/1.85 cores；缺失 throttle series 保持 unknown。
此证据把等待定位到发出请求之后，但尚未区分 Engine gateway、Actor 获取、Host dispatch
与 SQLite commit；不能直接认定某次后台任务就是首错因果。

模型必须以每份有效工作而非每次返回成功为单位。共享 compaction lane 的可观察完成者
成本为 `sum(completed_rate_k * mean_execution_seconds_k)`：04:29 约 A 11.86 / B
11.90 service-seconds/second，接近各 12 个许可的名义预算；stage 占已观测成本的大部分。
这只是 completed-cohort service-load proxy，不是精确利用率、offered rho 或有效吞吐。
五分钟窗口在开始/结束处归属不一致，missing error/timeout 不能补零；Complete admission
可绕过实际工作，execution timer 不含之后的 durable history commit。
源码的 `run_admitted` 持有 guard 直到整个 activity 返回/取消，但 guard 获取早于 timer，
不能由上述 proxy 推导精确 permit 占用积分。

stage 的成本还须按实际流水线拆解：

```text
S_stage = S_prepare_committed_prefix
        + sum_over_prepared_shards(S_read_immutable_base + S_merge_encode_hash
                                   + S_publish_fenced_batch_transaction)
S_install = S_integrity_preflight + S_atomic_root_publish + S_conflict_recheck
work_per_effective_prefix = planning + stage + install + required cold/reclaim
                           + invalidated rework + durable replay/commit
```

`db_hot_compacter::stage_hot_job` 逐个 shard 串行事务，而 stage planning 指标只计第一笔
`depot_hot_compact_stage`，不包含后续 publish batch，不能当作总 stage read bytes。
Runtime 59 的 `plan_staged_hot_shards` 对每个 coverage txid 重新遍历已选 DELTA，
materialization 对每个输出重新读取 authoritative base；coverage、基底大小与分片数是成本维度。
这些是源码确认的潜在放大路径，不代表本轮已测得 coverage 次数或实际字节放大倍数。
coverage 由 PITR/history pins 决定，不能删历史覆盖、lifecycle/fingerprint、truncate、
backup 或 install integrity fence 来提速。上面的 A transaction 均值到故障前为 prepare
约 253 ms / publish batch 145 ms，后者不等于整份 stage 的总成本。

确定整改顺序如下，不在失败 run 清理期间 rollout：

1. 补齐成本归因：固定维度的 effective/retryable/rejected 输出、每 job 输入 DELTA bytes、
   coverage/shard 数、phase read/commit/replay 和 eligible-debt/oldest-pending；不加 Actor
   metric label。继续区分 committed-prefix 进度与仅 activity succeeded。
2. 先减少每份有效工作的成本：合并重复触发和不变输入的规划；在字节/事务界限内增量折叠
   多个 coverage 的共同前缀，避免重复解码/拷贝。任何 immutable-base 复用或 bounded batch
   并行都须证明 exact watermark/fingerprint、GC/backup fence、取消和失效后的重做安全，
   不能只提高并发。
3. 对共享资源给出前台预算与后台分阶段预算/有界工作量；同一 lane 不能默认保证 cold /
   reclaim 获得进度。阶段保留份额只能解决公平性，不会增加总服务能力；总 eligible debt
   持续增长时仍失败，不以更长延期或历史保留掩盖。
4. 用不变业务输入检验服务曲线：目标与实际持久交互率、前台尾延迟、有效 prefix/冷发布/
   安全回收、队列年龄及债务斜率一起验收。之后才决定容量与扩容提前量。

设计修正的顺序是先降低每份有效工作的重复规划/失效重做，再控制 Cell 总维护预算并保护
前台 durable commit，最后才根据真实服务成本增资源。若活跃数据库各自按周期 `T` 触发
维护，基础需求随 `N/T` 增长；增加 Engine 而同时增加规划扫描和竞争，会形成正反馈，
不能当作线性扩容。应分别校准事件触发/合并、active-job 小额观察、真正需要的全量规划和
安全回收；未改变 dirty 输入的重复 wake 不应制造新的数据工作，但持久 signal 不得丢弃。
低容量启动时，云节点创建/镜像准入延迟属于 supply lead time。已有 headroom 不足时，
分钟级 warmup 等待不能被标成三秒创建达标；需用到达率乘供给延迟规划预留与扩容提前量，
而不是借后台维护均值推断创建 SLO。该模型及工具尚不替代 strict10k 的实际终态门禁。

#### 前台成本向量与共享资源门禁

容量资格的前置检查必须尊重各层所有权。Durable pool 的低容量起点仍是每 Cell
四 Host/四 canonical Machines；中央 API 由 HPA 按 3..30 策略管理，不能为了
满足旧脚本的固定三副本假设而手工缩容。前置检查要核验整数 desired、观测 generation、
Ready/updated 收敛、原 UID 和 exact image，并记录实际配置，不把允许动态副本当作
允许部分 rollout。Runtime 与工具图分别绑定 immutable revision/manifest；新镜像只有
在两 Cell 原生 Bottomless/HA、activation/control/audit 字节链及 live Ready 均通过后
才可进入原始万级负载。准备或传输 wrapper 不是测试已经启动或容量资格已经通过。

慢冷降必须按状态进度归因，不能把整个等待时间记为 COS 服务时间。2026-10-03 B
原 c631 qualification 的精确大数据库已到 head/hot/cold watermark 179，而全波次
hot shard 数仍从 90 降至 26；一次有界分支读取发现 history pin 空、dirty null，
PITR interval 保留最新 txid。该事实尚不能确定剩余等待原因。诊断须结合 exact
manager job/lease/attempt、策略到期与有效回收批次，区分可回收债务、合法保留和
失效重排；保留 pin/publication/lifecycle/事务预算的所有安全检查。只有可回收
债务持续增长且实际服务需求超出预算，才进入容量调整；低效重复扫描或逐项串行
验证则先修单位工作量和关键路径，再用相同 strict10k 证明收益。

因果取证也有生命周期边界：精确冷态通过并执行 cleanup 后，本次分支的
manager/reclaimer tag lookup 已为空，不能由此证明先前没有排队或失效 job。
慢分支应在 inflight 时按 exact branch 保存 job identity、due/lease/attempt 与
阶段进度，和同窗前台/债务关联；不得靠完成后全库扫描补造历史。最终资格收据
能证明状态与安全门禁，不自动证明等待原因或设计修正的吞吐收益。

进一步的只读 request-path 与独立 phase query 原字节、SHA、invocation 和限制见
[evidence README](../../deploy/tencent/fleet/load/ten-thousand-active/evidence/README.md)。
04:25--04:36:30 的滚动直方图显示 A ready-wait p99 从约 0.97 秒升至 24.22 秒，B
末端约 2.35 秒；两 Cell 的订阅 p99 均小于 5 ms。A 同时有 gateway lookup、SQLite
commit、Gateway accounting 和多类 Gasoline transaction 延迟上升。这支持“共享资源
争用、对象就绪链被放大”的候选解释，但不是首错请求的逐阶段因果 trace。
无界日志之外的缺失匹配不能证明请求没执行；502 副作用边界与零透明重试保持。

同窗末端 A/B SQLite commit 完成率约 427.7/451.1 per second，gateway accounting
865.4/904.6，gateway lookup 898.5/908.9。两 Cell 的交互规模相近而延迟差异显著，
不能只由 Agent 数或总平均 CPU 解释，也不能把异步完成率相除当作每请求精确放大。
需要继续核验 FDB process/分片与机器映射、读写与 commit 延迟、磁盘/NIC 和热点范围。

源码确认 HTTP Gateway2 有两笔统计 transaction（入口和成功记录入口之后的出口），
入口使用 `tokio::join!` 等待统计与业务响应。统计每次读取 Actor name 并 atomic-add
namespace/name counters，不能把它当作免费的 Prometheus 采样。Gateway2 每次还做一次
authoritative Actor lookup，Guard route cache miss 会多做一次；每个 lookup 有十个点读。
VFS/remote SQLite 还有 generation 验证，真正 commit 内的 serializable writer fence
不可删除。这些成本必须计入 Cell 的前台预算，而不只是业务 DELTA bytes。

```text
for each shared resource r:
  foreground demand_r = sum(request_class_i arrival_rate_i * work_per_request_i,r)
  total demand_r = foreground demand_r + effective maintenance_r + rework/replay_r
  stable service requires total demand_r < measured sustainable capacity_r

work_per_request = (FDB point/range reads, keys/bytes written, commits,
                    execution CPU, network bytes, cold I/O)
```

这里的 sustainable capacity 不是配置的 permit 数或已完成 histogram rate；应在固定
负载和实际资源身份下测量，并留 tail-latency/headroom 余量。actor 数决定基数/内存，
请求率和读写形状决定实时需求；bootstrap 就绪链与稳定交互分开校准。扩容的提前量仍
需覆盖供给延迟，不能将生产请求超时抬高来替代三秒创建资格。

统计若脱离响应路径，必须先定义它是运营观测还是精确计量，再设计有界缓冲、合并、
flush/restart/过载语义。随意 spawn 无界 task、丢计量、删除 generation 检查或延长
timeout 都不属于已批准的修复。FDB 资源隔离与后台预算只能保护公平性；重复工作成本
和总负债不能因此忽略。

#### 构建与在线控制面的共同资源故障

性能模型不能只包含 Engine/FDB。2026-10-03 的只读诊断确认 C 的 bootstrap builder
同时是可调度的控制节点，`/data`、Buildah、containerd 和系统共用 100 GiB 根盘。
在 06:23:37 UTC 该节点 DiskPressure True、MemoryPressure False，Workers API 多次
被驱逐；API 容器自身只占几十至百余 KiB 临时空间，不支持“API 自己写满磁盘”的归因。
增加 API 副本并不消除这个共同资源故障。

06:32:05 UTC 实际 custom-metrics 查询证明两项 Router HPA 指标均返回 unable to fetch
metrics。唯一 APIService 指向正确的 Hub Adapter，两 Adapter Ready，但 Hub Prometheus
Pending。随后实际 Pod scheduling condition 给出一个节点有 disk-pressure taint，另外两个
节点有 volume node affinity conflict。该事实解释当时为何有正确 Adapter 配置却没有值，
不代表所有历史指标故障均由此次构建造成，也不能反推 04:36 首个业务 502。

容量闭环因此须分别约束三项预算：在线节点的 nodefs 可用空间及 kubelet reserve、
构建 source/target/image 的峰值临时空间与可回收缓存、观测面在其保留盘拓扑内的实际可调度性。
`mkdir /data` 不等于数据盘隔离，单次“20 GiB free” bootstrap 检查也不是构建全生命周期预算。
构建准入应以峰值空间和在线 reserve 判定，不能由在线 Pod eviction 被动替构建释放空间。
优先设计独立 builder 或独立挂载且受预算约束的构建盘；保持原源码闭包、镜像和证据来源校验。
实际迁移必须沉淀为 Terraform/bootstrap，不能在长作业持锁时手工移动目录或任意删除缓存。

2026-10-04 新镜像已完成 A/B 发布资格后，严格万级 launcher 在实际负载开始前被 C
nodefs reserve 拒绝：同一 `10.160.0.4` UID Ready、DiskPressure=False，但只有
16,533,864,448 可用字节，低于 `15% capacity + 2 GiB` 的 17,990,614,016 字节。
另外两节点与两项 HPA custom metrics 正常，systemd unit/log/load/preflight 均不存在；
这不是新镜像的万级请求失败，也不能用 Kubernetes Ready 替代实验余量预算。
旧解压源码缓存约 22.9 GB，必须将当前 source/tools/rollback、进程和 systemd 引用排除，
仅在原 whole-operation/build locks 内通过完整 v2 bundle/manifest/额外状态校验后退役。
保留可恢复的压缩 bundle 与 receipt，按 exact plan hash 和十分钟有效期执行，先全部验证
再删除，逐项保留 native journal；不触碰业务卷、对象存储、live container 或 eviction
门槛。此操作恢复实验前提，不证明运行期容量控制或万级负载已通过。

恢复余量后仅启动一次 `7d5fa6acee6a4a0fa60ea59d4b9ffe91`，runtime source2757与
tools120保持不变。20:21:13 UTC累计2,274 ready、127,081成功交互，普通重试/失败/
身份漂移均零；A/B Host自动目标65/68，Ready52/60，不混作全部可用容量。
低容量预热固定2 Object/s，已有543 Object发生过容量等待、最长约243秒；三秒SLO
只适用于后续1,000新增对象且当前样本仍零。因此不能宣称冷启动创建SLO达标。
20:02--20:20:55 UTC的immutable prefix每Cell67样本，UDB pending峰96/126、
采样compaction waiter峰均零；末尾hot-stage均值145/228ms、install174/198ms。
同时authority逻辑账本斜率约60.9--63.6/64.8--68.5千字节每秒，末尾reclaim rate零。
低水位暂未观察到排队不证明高水位吞吐、长期冷热平衡或物理COS成本；必须继续原
完整负载/cleanup/自然缩容，并将高水位单位工作成本与债务斜率分开比较。
该次native pressure stdout在8192字节处截断且Dropped=0，不能据此判断输出完整。
实际归因使用原COS relay验长度/SHA后的完整append-only prefix，舍弃不完整JSON；
五分钟rate窗口必须含于明确负载窗口，晚于边界的query保持unknown而不补零。

新的只读 `verify-builder-storage.py` 将这个边界接入正式 Runtime 构建：remote preflight
在临时 push token 前检查，持稳定 build lock 后复核，直接 build-image 入口再校验实际
stage/Cargo/TMP 路径。所有 bulk 路径必须位于非系统 ext4/xfs 块设备文件系统；未知或
tmpfs/overlay/network backing 不通过。系统保留 max(20 GiB, 20% capacity)，每个独立
bulk filesystem 保留 max(10 GiB, 10% capacity)，还需 64 GiB 构建增量；同设备的路径
合并预算，不重复计费。nodefs/bulk 还各需 16,384/81,920 可用 inode，不能只看 free bytes。
这是保守 admission floor，不是已校准的 V8 峰值或硬 quota。
只读快照不排除同盘其他 writer 和后续耗尽，实际布局隔离与运行期保护仍需完成。
不降低 kubelet eviction 门槛、不由检查器安装/格式化/移动目录，也不补零 HPA 指标。

重建模板现在声明单独的 build-only CVM 和 CBS：management 根 owns 它们，builder
不加入 TKE，原三个控制 worker 的资源和身份保持不变。默认 512 GiB 是可配置构建盘
envelope，不是实测 V8 峰值。独立 runtime_builder_inventory 输出显式绑定
instance/zone/disk/attachment，不进入严格的 management platform inventory，并保留
原 bootstrap 的 operationsInstanceId；release/qualification 仍只有原共享操作锁。
Terraform 不执行格式化或旧目录迁移，storageBootstrapRequired=true 明确表示还不能
构建。真实 guest disk identity、初始化/挂载、全部实际写路径 admission、受控构建交接、
旧根盘缓存的安全退役和 Prometheus/HPA 恢复须另行验证；源码模板不能代表云上整改完成。

只读 storage identity planner 先把 Terraform 输出与两分钟内的实际 CVM/CBS API、
management Node inventory 和 guest metadata/lsblk/by-id/wipefs 做 exact join。
builder 必须不在 TKE；云盘为同区 exclusive attached data disk，所有权 tags 匹配。
guest serial、by-id、容量须指向同一 cloud Disk ID；root ancestry、已有分区、文件系统、
挂载和签名均拒绝。磁盘字母不是身份，实际 C 的 vdb/vdc 是生产 PVC，不能格式化。
planner 的通过只生成 storageReady=false 的 empty-disk plan。独立的只读 collector 已实现：
control 通过原 TAT helper 获取 guest 原生观测，guest 先校验 metadata 身份再读 exact disk；
云凭据不进入 guest，仅必要 API 字段/ownership tags 进入证据。最早 cloud 与 guest 时间
均须新鲜且有序；真实协议进程回归不代替尚未创建的独立 builder 云上正例。
collector 不实现格式化或持久挂载，不授予未来任意时间的破坏性权限。真正初始化前须在原共享操作锁内重新
观察；崩溃恢复、已格式化盘复用、持久挂载和实际 build path admission 仍需单独闭环。

独立 initializer 的源码现补上 root-backed fsync journal：`formatting -> formatted -> mounted`，
绑定 exact inventory/instance/CBS/capacity 和生成的 filesystem UUID。初次格式化前重采
guest 身份并要求 cloud observation 仍在两分钟内；不接受既有分区/签名或 root/TKE/PV。
格式化成功但响应丢失时，通过匹配 UUID 与只读 fsck 恢复，不重格式化已完成文件系统；
foreign/partial signature、journal 身份变化及未知状态 fail closed。journal 不依赖尚未
挂载的数据盘，formatter 之前必须持久落盘，mounted 状态不能回到格式化。
持久挂载用 exclusive `data.mount` 与唯一 UUID，并以 actual findmnt/block observation
验证；不通过 nofail 回落根盘，不移动既有缓存/目录。默认 empty planner 语义保留，
collector 的 attached-only 只为恢复采集，不授予 ready 或格式化权限。local 文件/协议
子进程与 native ext4 regular-file probe 是局部证据，不证明真实 CBS、reboot 或发布。
原 operations host 仍唯一 owns 全程共享锁；guest local flock 仅防同节点重复初始化。
MountVerified 仍保持 storageReady=false：Buildah 真实 GraphRoot、全部 bulk backing、
资源 reserve、toolchain/cache 和受控 handoff 必须独立通过，不能由 journal 替代。
锁持有的 coordinator、真实新 builder 初始化/重启/构建交接尚未云上完成。

coordinator 源码已进一步绑定 reviewed revision/full manifest 的固定工具闭包，并通过原
operations wrapper 全程持锁、实际锁冲突检查与 native metadata 验证 operations host。
一次有界 TAT payload 在 private root-backed temp 中转移工具/inventory/新观察，不先创建
`/data` 或携带 cloud credential。root-backed 提交 intent 先 fsync，绑定实际 TAT payload
bytes；state 以 host 身份索引，改变 inventory bytes 不能绕开旧 intent。记录 invocation
前还持有 private per-host intent lock，原 wrapper 的 sibling 子命令不能同时覆盖提交意图。
该局部锁不取得 fleet 操作权限，也不替代原全程 operation lock。记录 invocation
后的观察失败或重启只 collect 同一 handle，未知状态保持锁、不产生新 mutation。
提交响应丢失的 `submitting` 必须 fail closed，原 unique commandName/native 调用尚未
查清前不自动重发；不能承诺 local journal 与 TAT 原子提交，也不能将进程死亡后已释放的
flock 伪装为仍持有。入口须由原 operations host 的监督作业运行，不能靠 disposable
client waiter。重复成功返回的是历史 mount receipt；fresh `--recheck` 只在原 native
terminal 已收集后执行，原 helper source 身份保持。真实 lock/TAT 协议进程回归仅证明
本地协议语义，不代表已创建 CBS、完成 reboot 或发布性能修正。

07:08:46 UTC 的新观察表明 Prometheus 暂时 Ready、HPA condition 恢复 ValidMetricFound，
但 C 原 builder 节点仍 DiskPressure、构建仍共根盘。没有实际查询两项 custom metric 值，
也没有负载窗口，不能因此宣称控制闭环稳定或整个性能问题已解决。

监控是扩缩容控制输入，不只是可选 dashboard。HPA custom metric 无值必须保持 unknown，
不得补零来强制缩容；未知时保守拒绝缩容是安全行为，但不证明无人值守能力已合格。
观测恢复验收应包含 Ready Pod 的实际 QPS/in-flight 值、保留盘拓扑、节点空间水位和重启后
链路恢复。不能通过容忍 DiskPressure、降低 eviction threshold 或替换保留 PVC 掩盖问题。

07:54:04 UTC 的真实 kubelet summary/configz 进一步显示 nodeFs 与 imageFs 共容量和
available：约 14.67% 可用，已低于实际 imagefs.available=15% hard eviction 门槛；
imageFs 自身只用约 4.39 GB，不代表 backing 空间安全。资源模型须以实际共享设备的
总需求与 reserve 为准，不能把“镜像少”推断成“不会阻断调度”。这是当前控制面故障的
证据，不是原万对象请求首错的逆向归因；不同时间的 df/stats 也不证明特定写入速率。

08:05 UTC 的有界缓存退役已取得真实 SUCCESS/0 收据：在原 operations/build 双锁下，
重新验证 C/A/B 全 namespace 的 40 个保护引用及 TCR 的完整归档集合，只删除剩余
15 个精确旧本地镜像，无额外父镜像删除。root available 从 16,886,652,928 增至
21,554,479,104 bytes；业务数据、PVC、源码、Cargo 缓存和 TCR 对象未动。缓存清理
只恢复空间余量，不是构建隔离；当前共盘布局依旧不能通过新的 build admission。

08:11:44 UTC 同 UID 的 native kubelet 样本显示约 19.1% backing 可用，DiskPressure
已于 08:07:59 转为 False，API 12/12 Ready。近期 API Pod 的实际 DisruptionTarget
明确为 ephemeral-storage 驱逐，因此这条控制面资源耦合有直接证据；后续 TKE native
也报告三节点 running。中途曾 False/True 抖动，不以单次 df 或瞬间 False 宣称修复。
HPA 当前读取到 QPS/in-flight 为零并有 ValidMetricFound，只证明此时空闲观察链恢复，
不证明负载中的指标连续性、扩容成功或原业务 502 的唯一根因。

恢复后的完整 Terraform plan 已保存，审计结果仅新增独立 builder 的 CVM、CBS、attachment、
security group 和 egress rule，共五 create、零 change/destroy、零 drift；尚未 apply。
A/B 对 c631 性能修正产品的正式 preflight 均通过，A release/qualification 已提交原不可变
TAT invocation。该候选降低重复 fold 输入访问及独立点读等待，不能据已构建或发布开始
宣称 strict10k 已通过。实际缓存收据和发布句柄见 [容量证据目录](../../deploy/tencent/fleet/load/ten-thousand-active/evidence/README.md)。

A 的 c631 rollout 已于 08:18:27 UTC 完成：原 operations cycle pre allow/0、release
action exit 0，原生 ledger 的 source、manifest、远端 digest 和静态身份已按原字节验真
归档。post-action 的 block/1 仍原样保留：旧 receipt directory 找不到新 ledger 的
外部收据；切到新目录后 static ready=true、driftCount=0，只剩新 Bottomless/HA 收据
尚未完成。它不是新 workload 漂移，更不是可以自动跳过资格的理由。
08:25:16 UTC 新版本 gate 已完成 48 个在线/最终 checkpoint 与 post-sleep reclaim 请求，
20/48 精确冷态、28 pending，无冷态读取/清理错误；后续 cold wake、HA、激活和 B
完整资格仍待终态。同一小规模 gate 的进展不证明万级成本模型或整个 Phase 5 完成。
08:32:17 UTC 同一 gate 为 36/48 cold-ready、12 pending，读取/清理错误仍为零，
stage 仍等待精确冷态；不将变化的 shard 数当作精确 reclaimed-byte 吞吐。

A 原 invocation 在 08:36:16 UTC 正常 SUCCESS/0 终止，最终原字节资格收据已经
COS relay/hash、正式 production-cell verifier 和 HA/activation hash 链验真归档。
48 Object/6,240 writes 的 cold wake p95 719 ms、p99/max 1,998 ms；HA fault
期间公共 /v1 1,500 次请求零失败并验证后续 SQLite 写入。原 Cell UID 的 Ready/
readyForPlacement 和 release-bound control allow 已实时核对。这是当前 Cell 资格，
`claim_eligible=false` 保留，不冒充原标准 strict10k、全产品无限容量或百万资格。
B 在 A 前置通过后于 08:40:20 UTC 提交同一 c631 产品，仍待终态；不降低门禁或重编。
08:48:05 UTC 原 B Engine 6/6、Host 4/4 已收敛至 exact 新 digest，48 个在线/
最终 checkpoint 和 post-sleep reclaim 已执行；精确冷态仍待 48 对象，无读取/清理
错误。B rollout 不等于 cold-wake/HA/activation 通过，也不授权抢跑 strict10k。

B 原 invocation 已于 09:29:08 UTC SUCCESS/0，原五份 Bottomless/HA/activation/
control/audit 收据已按源字节归档并验 SHA 链；live 原 Cell UID 的 Ready 也已核对。
48/48 exact cold、6,240 writes、HA 1,500 请求零失败，冷唤醒 p95/p99 约
1,109/2,320 ms；精确冷态等待约 41 分钟的原因仍未确定。随后仅启动一次原参数
strict10k run `200a42ae03ef4e128505b0def22e8af8`，从每 Cell 四 Host/四 Machine
开始，API 副本仍由 HPA 管理。实际 systemd InvocationID、immutable runtime/tools
及低容量起点已核对；预热成功不等于万级容量通过，也不将 SDK 已就绪集合当成
同时活跃的 runtime 实例数。对照必须同时报告目标到达、实际派发与完成率，保留
三秒 post-warmup SLO、零普通重试、精确 cleanup 和无人值守自然缩容门禁。

原 audit 的 memory/storage headroom ETA 各含两个 Python float Infinity 叶子，
JSON 严格消费者会拒绝其非标准序列化。归档保留源字节和 control→audit SHA 链，
不由诊断修改历史。后续工具应显式编码非有限值，不能补零、改成有限容量预测，
也不能将 unknown 观测解释为健康；这不是本轮实际 throughput 的证据。

#### FDB 适配层点读的串行放大

同窗 FDB 诊断绑定原 run `55b55875` 和两 Cell 的 CR UID，十八个历史 Pod UID
均与当前 Pod 匹配、重启为零。A/B 的九个 FDB 容器一分钟总 CPU 峰值约 6.756/6.585
cores，单容器峰值小于 0.89 core，配置各 2 CPU / 8 GiB；RSS 单容器峰值约
4.13/5.44 GiB。前台 commit、gateway lookup/accounting 和 signal pull 的平均尝试
次数接近一，后台 full refresh 峰值为 1.95/1.523。ratekeeper released/limit 采样
约 8.5--19.1% / 11.7--17.7%。这些证据不支持“前台 conflict retry 风暴”这一解释，
也不证明 FDB 服务无瓶颈：一分钟均值会遮蔽突发，单线程、局部热点、网络和磁盘尾延迟
仍须独立核验。`nodeExporter.enabled=false`，node/disk 空集不能补成零。

源码确认 `get_for_gateway` 在一个事务中 `try_join!` 十个独立点读，但 Runtime 59 的
FDB adapter 逐个取 command、await native read 完成后才取下一个。因而上层并发在
适配层被串行化。对十个独立读，关键路径近似从 `max(read_latency_i)` 变成
`sum(read_latency_i)`；这是源码成本模型，不是本次首错的实测十倍归因。低 CPU 与
高 pending 可以同时出现，因为在途请求等待 I/O；`L = arrival_rate * latency` 只在
定义一致的稳定窗口内适用，不能用不同滚动窗口机械相除。

新源码只重叠相邻 `Get`/`GetKey`，每笔事务最多十六个 native point-read future，
仍在 FIFO command 顺序中创建。所有 mutation、range read、option/conflict-range
变更、commit、reset、cancel、on_error 都先等待之前的 point reads 完成；没有额外
spawn、跨事务缓存或 snapshot 降级。范围读保持串行，既有 command queue 和结果字节
预算没有因此变为全局有界，仍须按请求成本向量进行 Cell 级 admission。

这项修正降低等待链长度，不减少十个 FDB 读的工作量，也不消除后台 full refresh
与前台共用存储资源的竞争。必须同时评估 FDB read demand、后台有效进度、hot debt
和前台尾延迟。保留 writer generation 的 serializable 冲突、native retry/reset 与
maybe-committed 分类；成功的本地 native FDB 顺序/冲突回归不能替代正式 release 和
相同 strict10k 的容量结果。未取得新运行时实证前不声称整体劣化已经解决。

#### 多 coverage 共同前缀折叠的局部修正

新源码 `plan_hot_coverage_shards` 将请求 coverage 的本地索引排序，对已选 DELTA
仅做一次有序应用，然后在各 coverage 的 EOF 下复制必需输出。返回顺序与重复
coverage 保留；每次中间 shrink 都淘汰旧页，后续 grow 不会复活它。合并状态不超过
输入中可见页集合，输出继续受原 FDB staged-row 上限约束并提前失败。
现有提交元数据选取、immutable base 读取、stage/publication 事务和全部 fingerprint/
history/PITR/lifecycle/GC/backup fence 不变；不是新的 publication authority。

原算法作为测试 oracle 保留在 test-only 代码，用真实 LTX encode/decode 对比历史
输出。128 个逐提交 coverage 的已知重复 DELTA 应用数原为 8,256，新 fold 的输入访问
数为 128；这只是算法工作次数，不是 64 倍端到端收益。输出快照复制仍不可免，提交
元数据选择和 FDB materialization/publication 成本也仍存在。该源码局部优化尚未发布
到 Runtime 59，不能据此将 A ready timeout 或完整 10k 门禁标为修复。

性能修正的发布证据也分层：本地算法回归、reviewed-source build、A/B runtime qualification、
相同 strict10k receipt，不能互相替代。正式 builder 的默认 Python 3.6 不满足 stage closure
verifier 的 subprocess 接口；共享构建入口须在授予 push authority 前验证已安装的 Python 3.11，
并让所有子 helper 通过进程内 shim 使用它。不得因此替换系统 Python、跳过 compiled-input
projection，或把一次构建失败误报为线上性能回归。

2026-10-03 Runtime source `59e86519`、manifest `24b265e9`、image `05840b48` 已在 A
完成正式 rollout、production-cell Bottomless、Engine HA 和新资格 activation；原 invocation
`inv-e9ecw30f8e` SUCCESS/0。B 同一产品的原 `inv-a9ednt0v6b` 也已 SUCCESS/0，
完成 rollout/Bottomless/HA/activation，没有重发资格作业。
A 五分钟只读采样已能区分新指标：active observation 约 165 bytes/完成事务、8.05 ms
平均返回成功执行时间；同窗完整 refresh 约 76,285 bytes/完成事务。采样来自小资格流量，
不是万级前后对照，不能将不同事务类型和不同负载的均值直接换算成业务吞吐收益。
缺失的 timeout series 是 unknown，不自动补零；返回 succeeded 仍不代表有效 fold 或 history
commit。完整 phase、原字节收据摘要和剩余验收记录在 10k durable pressure Task。

本轮 A 原始收据在本地重新验 SHA、按 production-cell profile 重验通过：48 对象、
6,240 写入、48/48 exact cold，冷态等待约 954 秒，cold wake p95 约 942 ms，HA 1,500
请求零失败。这证明小规模功能与恢复，不证明后台持续吞吐或万级交互 SLO。冷态等待包含
安全 reclaim 的 pin/retention 等资格条件，不能直接当作 COS 上传吞吐；须结合有效 publish、
安全 reclaim 和 hot debt 走势区分策略等待与实际服务不足。
正式 qualifier 对测试数据库设置的 shard-cache retention override 为 1 ms，并请求
checkpoint/reclaim；该等待不证明默认策略的自然冷降时延，也不能据此将延迟归因于缓存 TTL。
B 新收据同样 48/48 exact cold、约 964 秒等待，cold wake p95 约 1,115 ms，HA 1,500
请求零失败。唯一 strict10k run `55b558752ba2454987491cdea655ff68` 已 failed 终态，
未达到万级 active 资格；原 receipt 的 exact cleanup、自动扩容观察、安全 drain 与回归
低容量检查为 true。该终态既不能覆盖容量失败，也不证明性能修正已发布。完整证据见
`deploy/tencent/fleet/load/ten-thousand-active/evidence/README.md`，不重发原 supervisor。
性能验收继续保留目标到达率、实际到达率、成功率和尾延迟：每对象单在途模型在响应变慢时
会自行降低到达率，因此不能仅凭“成功率高且队列稳定”证明支持目标的 1,000 持久交互/s。

共享 Agent 负载器为这一缺口增加常数空间的 `activeDemand` 诊断：原 timer 访问槽、
实际派发、未就绪/单对象已有在途/停止的互斥跳过分别计数，派发必须等于原 activeAttempts。
逻辑 heartbeat 派发与物理 fetch 尝试分开：activeHttpAttempts 包括重试/取消尝试，
不代表请求已抵达服务器。真实 HTTP 故障回归证明额外一次尝试可计入物理工作，
而原零普通重试的资格仍不可逆地失败，不用逻辑操作数隐藏重做成本。
调度时钟积分给出理想槽数与 timer 缺口，同时保留名义对象频率和离散向上取整频率；
阶段切换不抹掉 warmup，停止 timer 后的排空不计入新需求。真实 HTTP 回归暂停对象零的
首个 heartbeat，待另一对象完成下一轮后释放，证明零失败仍可存在被抑制的工作。
诊断不改变一对象一在途、节拍、三秒 SLO、重试或资格判定，也不把理想槽数当作真正
发出的请求。当前已运行 tools-120 无该字段，不能事后重标证据；吞吐仍需要同窗
派发/完成率及后续固定到达性能门禁，而不是新增一个容易通过的成功条件。

诊断正确性也必须独立验证。Gasoline debug history 原读取器在 signal index 0 的第二个
input chunk 上再次要求 `len == index`，会把合法多块输入误判为损坏。真实 RocksDB/UDB
写入的多信号/UTF-8 多块 fixture 证明生产 replay 可以成功而 debug reader 失败。修复仅在
新 signal index 创建时检查连续性；单块、多块、缺失 index 和非法 chunk 四项回归通过，
Gasoline 全部 22 项 lib 测试通过。不改生产 replay、持久键或编码，不因此重建 workerd，
也不能把这项诊断修复称为上述 10k 性能问题的修复。

性能窗口本身也需要门禁。pressure analyzer v3 只有在实际 query 的完整五分钟区间
位于显式工作窗口内时才输出 rate 派生量；跨边界 rate 为 unknown，instant gauge 与
ledger 仍可用，未声明工作窗口时 scope 为 null。输入校验在屏蔽前完成，不能用短窗口
隐藏 stale/非法指标。真实文件/CLI 回归覆盖 299/300 秒边界及 query 与 collector 时钟
错位，不改变 strict10k 成功条件，不重写旧 v2 evidence 或在途 tools120。

新 c631 原 run 200a42ae 的 09:40--09:55 / 09:55--10:12 不可变窗口见
[evidence README](../../deploy/tencent/fleet/load/ten-thousand-active/evidence/README.md)。
各 Cell 活跃数增加时 stage completed mean 暂未上升，whole-Cell authority 净增长却
加快；reclaim 仍为零。这不等于维护已稳定或内存/存储泄漏。warmup 同时增加对象
数量与数据库年龄，历史前缀到期会改变 eligible work mix。因此单位成本模型还须按
请求形状、年龄、eligible prefix bytes、coverage/base 大小和失效重做分组，不能直接
用两段总量相除证明随基数超线性放大。合法保留与可回收债务必须分开；小冷发布
planned-byte rate 与整个 authority ledger 不是同一口径，不能相减估算服务缺口。
原 run 仍无终态或 post-warmup 三秒样本，不由这些中间诊断推进 Router 资格。

运行中精确分支还必须区分「排队」与「无效重做」。同一原 run 在 10:29/10:31 UTC 的
[原字节分支/manager history](../../deploy/tencent/fleet/load/ten-thousand-active/evidence/README.md#current-run-exact-live-branch-install-rejection)
绑定 B Cell/FDB、Engine Pod UID 和 image：先观察到 install admission deferred，随后
有三行成功 staged output，但 install 返回 `bucket fork proof is ambiguous`；下一次
refresh 对同一 fingerprint、295--347 prefix 和 308/338/347 coverage 重建 Hot job。
这是一次确切 rejection/replan，不是全 Cell 拒绝率、丢数据或首个请求慢的完整因果证明。
48-entry active history 有界截取不能证明完整 loop state；缺少通用 StateKey 或 global
lease 也不证明 manager 丢状态或死亡，LUPE 持久状态属于 loop event。

运行中 c631 的 catalog create/tombstone 同时使变更数据库的 proof 失效，并递增 bucket root 与
256-way shard epoch。其他数据库共享 root（或 shard collision）时也被重新验证。
热 planner 未等待 proof 完成，而 install 必须等待完整证明。这样持续创建带来的失效
可能形成「proof reset → staging → install reject → 同输入 replan」反馈，消耗真实
FDB/CPU/执行许可，却不推动 watermark。后台需求模型必须把该返工单列，而不能用
stage success rate 代表有效维护吞吐。无 fork 的独立 membership churn 应只失效相关
数据库证明；新 bucket fork 仍需要树级 epoch、分页完成前仍 fail closed。源码现已实现
这个收窄：catalog 与 reverse fact 写入仍在同一事务清除相关数据库的完整/分页证明，
不再改无关树 epoch，也不再为 catalog 写入遍历 root。真实 RocksDB/UDB 的三个 churn
反例在修复前失败、修复后通过，另一个真实 fork/pin/history fence 回归通过。
另外覆盖 affected partial tombstone 清理，以及强制两个独立 root 同 epoch shard
时的无关 membership 变更；六项聚焦测试均通过，不依赖随机 UUID 恰好碰撞。既有
database/bucket fork 与 hot-prefix 回归保持通过。这不是已部署的性能修复；仍须验证
实际发布后的有效吞吐，以及分布式并发、分页重启、多层继承和 Serializable publication fence。
不能简单移除 proof/epoch 检查或把不完整证明当作可发布状态。

成本模型应显式写为 `后台资源需求 = 有效维护工作 + 必要重试 + 失效返工 + durable replay`。
旧 catalog 每次变更推进一个共享 256-way epoch shard，因而即使对象各有独立 bucket
root，同 shard 的其他证明也会重新验证；不必共享同一棵 bucket 树才能产生耦合。若每个
数据库订阅一个均匀散列 root，单次变更的潜在订阅者约为 `N/256`；多 root 和热点会
改变这个估算，它不是本轮实测重做次数。新 catalog 路径把这个变更影响限制为一个
physical database，真实 fork 保留保守的 shard 碰撞失效。仅调大 execution permits
既不减少失效次数，也不降低每次扫描成本，可能把更多无效工作压到前台共享的 FDB。
修复后的对照须固定 arrival/request shape，并报告有效 watermark/reclaim 的推进、
rejection/replan 比例、扫描字节与前台 p99；不能以更多 stage completion 判性能恢复。

实际 DO 映射不是上述独立 root 假设。`pegboard-envoy::actor_db()` 把
`conn.namespace_id` 作为 `Db` 的 bucket ID，把 Actor ID 作为 database ID；
`Db::sqlite_bucket_id()` 再转换该 namespace ID。原精确分支观察的 bucket 也等于
namespace ID。因此同 Cell/namespace 的 DO 共享 bucket，catalog churn 的树级影响
可能覆盖该 bucket 内其他证明，不能按 `N/256` 估算这条真实路径。潜在受影响者是
实际订阅该 epoch 的证明集合，不等于所有对象都会立即产生一次完整扫描。

模型中的放大来自工作依赖，而不只是对象数量：一个对象改变 membership，使其他
对象的证明失效；完成 stage 后 install 无法使用输出，又回到 refresh/replan。
应测量 `维护放大 = 实际扫描/执行工作量 ÷ 对应的有效推进工作量`；有效推进为零时
标记 stalled，不能给出零成本。即使每次扫描大小不变，返工概率上升也会使有效吞吐
下降。只有在独立 Poisson 变更、完整证明耗时固定且期间任何变更都会使它失效的
简化假设下，无失效完成概率才是 `exp(-变更率 × 证明耗时)`；这是解释反馈的模型，
不是本轮测得的概率或服务容量。收窄 invalidation dependency 是消除这种结构性
耦合的修正，不能用增大 execution permits 或延长前台 timeout 替代。

容量还必须按共享资源分别核算：前台有效请求成本、后台有效维护成本、失效返工和
durable replay 都消耗 FDB/CPU/网络或执行许可。一个资源的排队会延长另一个资源的
许可占用；不能用全 Cell CPU 均值推断每个 lane 都有余量。后续固定到达率对照同时
记录前台阶段时延、后台 installed watermark/reclaim、rejection/replan、scan bytes、
permit 占用和有界等待深度。对象基数、数据库年龄与 eligible prefix bytes 独立分组。
只有减少返工后仍有有效工作供需缺口，才据此调整资源预算或扩容；前后台预算隔离
与公平调度仍要保持 generation、publication、history/pin/backup fence。

为量化模型，热维护现复用既有 bounded compaction 指标，按领域结果记录执行成本，
不增加 FDB 读写或公共 output/schema。Gasoline 正常返回可能包含 retryable/rejected；
hot stage 成功只是 staged output，不是 root/watermark 推进。hot install 原事务把
fresh publication 与 marker replay 分开，后者记录 already_applied，不能计为新安装。
取消/future drop/panic unwind 记录 cancelled 成本并释放 gauge，准入等待仍单独统计。
这些是进程观察，不是 exactly-once 账本：commit 后响应丢失可能记录 error/cancelled，
进程死亡也可能完全不记录 fresh success；取消不证明未提交。durable root/marker、
watermark 与安全 reclaim 仍是有效推进真值，metrics 不替代它们。

pressure analyzer v4 分开保留上述结果/耗时、Gasoline 执行返回与 cold/reclaim 字节口径；
hot stage/install 不提供 byte/item 吞吐。旧 Runtime 缺失 series 继续 unknown，五分钟
rate 仍须完全位于选定工作窗口内。collector/analyzer 完整固定标签集合为 295 samples，
有界上限 320，不允许 Actor/branch/job ID 等动态维度。真实 Prometheus/取消、HTTP 与
文件/CLI 回归验证该观察边界，不把源码测试或观察计数称为万级性能恢复，不重写旧证据。

该测试又暴露一个独立的 bucket fork 默认读取反例：bucket 在 TXID 1 fork 后，parent
在 TXID 2 覆写，child 的默认 Db read 读到 TXID 2。pointer resolver 返回 inherited
physical database branch 后，read plan 未携带 bucket ancestry 的 versionstamp cap。
显式历史读能取回 TXID 1、materialized pin 存在，并不能证明默认 child 读正确。源码现已
单独修复：resolver 携带路径上最小 bucket versionstamp cap，默认读据此限制 head、EOF、
PIDX、历史 DELTA 与 SHARD；全局 bucket 时间点可能落在某数据库两次提交之间，因此
只在这种 AS-OF 选择中使用 reverse/limit=1 的 VTX floor。数据库 fork 的精确提交边界
仍要求 exact VTX，缺失时不能退回更早提交。未本地写入的 database fork 通过有界 parent
链读取已有 head_at_fork 对应的 COMMIT，校验 branch、cap、EOF 与 checksum，不伪造历史。

child 的首次写入必须在原提交事务内惰性 derive 一个新 physical database branch，写本地
pointer/catalog/policy binding，然后执行原提交；不得沿 inherited pointer 修改 parent。
derive 复用现有 history、GC、retention、pin/refcount 与深度检查；actor generation fence
仍先于分支解析。这没有增加持久 schema 或复制数据，普通无 bucket 继承路径不增加 VTX
floor/COMMIT 读取。新增真实 RocksDB/UDB 十项回归已通过，包括 parent overwrite/shrink、
非精确 bucket 时间点、多层 cap、late membership、虚拟 fork head、首次写隔离与缺失历史。
四项初始反例、虚拟 head 和 exact VTX 缺失的红测均保留；后者防止本轮 floor 修正放松
原数据库 fork 边界。既有 proof、database/bucket fork 和 lib 回归亦通过。

这只是源码局部门禁，不是当前首个 502 的已证根因，也未发布到运行中的 c631。父级
逻辑 pointer 变更/删除与 bucket 快照的组合、分布式并发以及真实 FDB publication 边界
仍需独立验证；不得据此宣称全部 bucket fork 语义或万级容量合格。性能修复和这项读写
正确性修复必须分别举证，不取消任何保留 fence。

原 run 于 10:49:47 UTC 在 9,086 ready/9,074 proven 停止，首错为 index 9035 的
initialize `502 indeterminate_result`；后续 2,294 个 active `network:20` 属全局取消
扇出，不是 2,294 个独立服务端故障。普通 retry 和 identity mismatch 均零，仍判失败；
post-warmup 三秒样本为零。首错前固定尾部窗口 10:40:46--10:48:51 UTC 各 Cell
24 个样本，B UDB pending 峰值 4,156，stage completed-execution mean 末端约
2.03 秒、admission mean 9.26 秒，A 分别约 0.48/2.14 秒。后台确有劣化，但该
相关性尚不能确定首错具体阻塞点；后台模型必须区分有效工作、失效重做、队列等待与
history replay，不用完成者均值冒充 offered demand，不由观察成功推进万级资格。

[原生 API transport 与 Engine 诊断](../../deploy/tencent/fleet/load/ten-thousand-active/evidence/README.md#current-run-first-failure-transport-and-cell-binding)
进一步缩小边界：10:49:47.163 UTC 唯一最早 header-timeout 候选请求到
`10.162.0.2:6420`，connect 2 ms、write 3 ms、25,003 ms 后仍无响应头字节，未复用连接。
它与客户端首错相差 8 ms，但客户端没有 request ID，仍不是精确跨进程 join。
读后 B Cell 的 UID-bound `engine-private` Service 确认该地址；它不是故障时历史
endpoint receipt，也不确定实际后端 Pod。六 Engine 的有界历史日志未匹配候选 Actor，
其中四份达到 byte cap；零匹配表示证据不足，不表示 Actor 未执行或请求没有提交。
目前不能把等待点认定为 ready、SQLite/FDB commit 或响应返回，也不能把已证
proof rejection 直接等同于这次 502 的根因。保持 `indeterminate_result` 不自动重放。

性能证据的编码也属于控制边界。headroom ETA 在增长率为零时可以是无限；
审计内部仍按数值判定阈值，写出收据时非有限诊断采用 JSON 字符串
`"+Inf"`、`"-Inf"`、`"NaN"`，有限数据编码不变。Prometheus scalar 的 NaN
不计为可用样本；全为空仍为 null，触发既有缺指标门禁，不能变成零压力或健康预测。
control SHA 必须绑定实际写出的字节，不得重新编码已经归档的 audit 来修补旧证据链。
严格 JSON、真实 collector HTTP 和 evaluator CLI 回归是诊断工具门禁，不是吞吐收益
或万级资格；此工具修正不要求重建 V8/workerd，也不修改在途资格的 immutable source。

性能整改的下一次发布必须保持可证伪：固定请求形状、到达计划与容量策略，按对象基数、
数据库年龄和 eligible prefix 分组，对比实际派发/跳过、有效安装推进、返工/扫描与前台
尾延迟。stage success 增加但 durable watermark 不推进，仍是无效吞吐；心跳因在途
而少发，不能算相同 offered load 下的改善。普通 membership churn 不再失效无关 DB
proof 是源码可验证的依赖边界，真正 fork、history/pin 和 publication fence 保留；它的
云端收益尚须发布后观察。消除返工后，如果有效债务仍持续增长，再以各资源的单位请求
成本和实测可持续供给确定扩容。原 strict10k 的一万活跃、零普通重试、三秒创建和自然
扩缩容门槛不变；native builder 创建或更快构建不属于业务性能验收通过。

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

### Stateless 命名缓存的驻留成本（2026-10-04）

Host 的有界代码下载缓存不限制 workerd 原生 WorkerLoader namespace。locked fork
`ce8bdf424dd94e93a39fd1385fdb459336eb76fd` 的命名表只有显式 unload/abort 才删除；
若每个历史 Worker/Version 都保留一个强引用，增加 executor 副本无法解决单进程长期增长。

root JS 因此单独拥有有界 name/last-use LRU，默认容量 16、idle TTL 60 秒，最大允许
256/3,600 秒。有效请求和 prepare 才触碰表；先校验鉴权、保留路径和 original URL，
再执行原生 get。容量淘汰与 TTL 懒清理都调用 `unload(name)`；卸载失败不得继续新增名字。
生产配置通过受信 root binding 渲染，不接收请求或用户 Worker env 覆盖。

JS 只保存名字，不跨请求保存 WorkerStub。原生 SubrequestChannel 的独立 Rc 保持旧在途
实例和响应流；同名随后可惰性新建，这符合 stateless 全局内存可丢弃的契约。不得复用于
持久 DO，因为 DO 的 generation/SQLite writer 由 Pegboard 与 FDB fence 管理。

成本拆为 `named references <= capacity`、在途旧实例、后台任务、V8/native/external
内存。前者有界不证明后三者归零，也不能把 cache.size 作为 `worker_isolates` 指标。
原设计的真实 isolate/cold-start/wake 指标与云上 Phase5 仍需补齐。

本地 gate 已用实际 production root JS 和既有 workerd binary 验证 LRU/TTL 重载、热复用、
旧流在淘汰和同名重载后完整、取消、URL/body framing，并通过 GC stress；测试入口见
[Host README](../../../../runtimes/workerd/host/README.md#无状态-worker-的命名缓存)。
本变更未发布，也未修改正在运行的 strict10k 图、镜像或容量。

### 严格负载失败的诊断边界

runtime2757 的 run7d5fa6ac 在 5,394 ready 对象时因一次普通 active 503 重试停止，
不得把最终交互成功重标为零重试或万活跃通过。原 supervisor 已精确清理全部测试对象，
自然缩容仍在运行；完整 failed/cleanup 原字节收据和归档见
[严格负载证据](../../deploy/tencent/fleet/load/ten-thousand-active/evidence/README.md#runtime-2757-strict-run-one-active-retry-exact-cleanup)。

故障窗内 C 的 12 个 API 监控目标可抓取，两类内部 overload 计数均为零；一个 API Pod
产生未分配 target Cell 的错误。公开 code 会折叠未知 retryable 错误，因此不能仅凭
`upstream_unavailable` 归因 FDB、容量或网络。空日志和成功重试也不是健康证据。
控制面 `requestJSON` 新增只在传输失败时记录连接阶段、有界 error 分类和已有 request ID；
不记录原始 URL/error、token 或 payload，不改变 timeout、response、retry 或请求副作用。
真实 HTTP POST 收到后断连回归证明无新增重放。该源码诊断尚未发布，不代表本次 503 已修复。

后续只读CLS检查确认：北京现有7个topic不能由名字认定属于本平台；当前A/B/C的标准
TKE LogConfig CRD不存在，未发现常见采集器，故本次不能依赖已安装的TKE→CLS通道追溯。
没有查询无绑定的其他服务日志，也不排除自定义外部agent/sidecar。证据见严格负载目录的
`2757-run-7d5fa6ac-cls-discovery-20261004.json`。日志是诊断材料，不是对象存储真值或
admission资格。未来标准采集应纳入Terraform/Argo desired state，绑定精确cluster/service，
优先保留结构化平台错误，默认不采集用户JS请求内容、Secret或console输出；不要用全量
DEBUG和无界日志量替代定位。原supervisor持锁期间没有安装或变更日志采集组件。

严格负载后的自然缩容还暴露一个独立liveness缺口：A在111 Ready Host、active0、无release
hold时停于35/35/41，最高ordinal110在较小AZ；下一前缀34/35/41的skew7超过当前缩容
边界6。低前缀最终可平衡不代表中间删除已被授权，等待也不会改变现有ordinal到AZ映射。
无secret证据为`2757-run-7d5fa6ac-drain-topology-20261004.json`；纯状态机回归复现此阻滞，
未改安全策略、RBAC或云状态。不要继续提高经验性skew阈值来宣布收敛。

后续拓扑修复必须与同一串行drain状态机组合：replicas保持不变，选择过量AZ的单台Host，
精确UID fence后等待fresh quiescence，以尊重PDB的eviction替换并重新验证目标AZ调度容量、
新UID Ready和拓扑改善；扩容优先、release hold、超时、重启及迟到响应仍fail closed。
纯决策状态机已实现在`internal/hostdrain/topology_rebalance.go`：同一annotation只保留单台
target，持久化workload UID、源/目的AZ、原Pod RV和下一个最高ordinal前缀的平方和。
每次再平衡必须严格降低该前缀的平方和，不能提高skew阈值；只选择当前已quiescent的
非最高ordinal Host，有已准入空闲目的AZ证据才可规划。低负载稳定窗口、fresh counters、
剩余容量、三AZ和扩容优先仍是硬前置条件。置换没有改善时保留Blocked，不重复制造换机风暴。

响应丢失不能直接恢复placement：删除只授权原Pod UID/RV。取消先对精确旧Pod执行新的
metadata RV CAS，观察属于同一epoch/eviction RV的取消凭据后才unfence。仅观察RV变化
不够，因为Kubernetes eviction本身会先更新DisruptionTarget并推进RV，再尝试删除。
若删除先赢，控制器只等新UID Ready，不把旧动作转给继任Pod，也不强制终止。
协议依据见[Kubernetes eviction实现](https://github.com/kubernetes/kubernetes/blob/master/pkg/registry/core/pod/storage/eviction.go)。

纯状态机回归已覆盖成功、重启/PDB拒绝/丢响应、取消与删除竞争、UID和workload替换、
稳定窗口、缺目的容量和不改善置换。四个120Host任意ordinal序列模型均逐台收敛至4，
保持最多单台drain；模型显式假设可用目的AZ被成功调度，不是实际K8s容量或云资格证明。
源码controller已接Pod owner UID/RV、取消凭据和policy/v1 eviction adapter；每次动作重新
核验持久state/工作负载UID/release hold/fresh容量，实际删除保留原UID/RV preconditions与
正常grace，不直接Delete。取消CAS不依赖Host HTTP；已授权eviction的观测失效时先持久化
Cancelling，后续只靠Kubernetes完成精确metadata CAS，确认凭据后才恢复placement。
StatefulSet状态和replica patch也绑定UID/RV与操作annotation，拒绝观测期间发生的配置变化。

`topology_capacity.go`只读当前MachineSet、限定500个Machines、1000个Nodes和5000个Pods，
拒绝partial inventory。目的节点需绑定当前Node/Provider/Machine/MachineSet UID、准入profile
与workerd image，且Ready、非drain、无未知taint。空闲专属节点仅允许DaemonSet占用，
按allocatable减去保守requests（含allocated resize、init、overhead、Pod slots），校验当前
模板hard affinity/hostname anti-affinity及目标AZ的zone-spread条件。未知硬约束拒绝修复；
这不是另一个完整scheduler，观测不是容量预约，实际置换仍由Kubernetes调度并证明拓扑改善。
只在拓扑阻塞或repair阶段读额外库存，不向普通应用请求增加RPC/FDB事务。

源码RBAC添加Cell namespace内pods patch/eviction create；集群级只有容量list及精确
MachineSet get，没有Pod delete/Node或Machine写入/全局Secret读取。新的
`RUNTIME_HOST_DRAIN_TOPOLOGY_REPAIR_ENABLED`默认false，installer向controller传递
`HOST_DRAIN_TOPOLOGY_REPAIR_ENABLED`；`RUNTIME_MACHINE_SET`同步绑定affinity及只读RBAC。
这些manifest尚未发布，云上权限/image/原supervisor都不变。21组新adapter/capacity测试
包含真实typed-client HTTP载荷与111Host完整reconcile（并发HPA扩容/STS变更拒绝动作），
但HTTP double仍不是实际Kubernetes/PDB门禁，不能据此打开开关或宣布111Host已收敛。
下一步核验实际server的UID/RV eviction与取消竞态，并走受锁发布和真实缩容资格链。

隔离的真实API门禁已在本机k3s `v1.35.5+k3s1`通过（143.35秒），证据见
`deploy/local/mesh/workerd-host-eviction-api-e2e/evidence/20261004-k3s-v1.35.5.json`。
它使用单个pause Pod及management stats double，实际调用同一controller的UID/RV
eviction/cancel adapter，验证PDB 429、真实CREATE eviction admission迟到请求被取消CAS
阻断返回409、取消凭据的authoritative GET、正常eviction后同名新UID拒绝旧操作，
并验证condition RV之后metadata CAS使stale DELETE存储前置条件失败。
测试namespace/webhook均已按exact UID正常移除；没有改变A/B业务Pod、Node或Machine。

取消后的PDB reservation不会立即归还：真实controller约2分钟后自然清理DisruptedPods，
门禁明确等待恢复，不修改PDB status或绕过预算。这是安全协议的liveness延迟，生产
仍应保留有界退避和超时，不能将429转换成直接Delete或换UID重试。
参考[固定版本disruption实现](https://github.com/kubernetes/kubernetes/blob/v1.35.5/pkg/controller/disruption/disruption.go)。
内部condition Update/Delete使用ValidateAll、不经过普通DELETE admission，所以本地
门禁没有截获真实server内部两次存储调用之间的窗口，receipt明确
`intraServerConditionDeleteWindowObserved=false`、`claimEligible=false`。
这是实际API primitive证据，不是完整Host状态机/Actor迁移或目的AZ容量资格。

2026-10-03T22:31:41Z云观测仍为A111Hosts/115Machines、B4/4，active0；原strict10k
supervisor同InvocationID/PID且继续持锁，负载失败与清理通过结论不变。TAT
`inv-a9fg78gqwm`为SUCCESS/ExitCode0；两Cell实际server均`v1.30.0-tke.22`。
upstream [v1.30.0 eviction实现](https://github.com/kubernetes/kubernetes/blob/v1.30.0/pkg/registry/core/pod/storage/eviction.go)
也检查UID/RV、更新condition后的delete RV并禁用带RV请求的冲突重试；这仅解释协议，
不证明TKE的实际行为。云repair开关仍false、源码未发布，A的真实安全缩容仍待完成。

Host drain源码属于独立`actor-fleet-controller` Go镜像，不在workerd/V8统一runtime二进制
内。仅变更此协调器不要求重编workerd；发布仍须使用新的immutable controller digest及
source manifest，通过既有串行release/rollback路径，不允许直接patch live image。
发布预检新增精确`workerd-host-drain-controller --help`，在每个控制节点以新digest运行，
要求exit0及固定Usage输出，早于容量协调器恢复或任何live Deployment rollout。
CLI在InClusterConfig、Secret读取及协调循环之前退出，并拒绝未知/混合参数且不回显值。
此预检只证明入口可执行，不证明真实TKE eviction协议、Actor generation或AZ容量；
原supervisor持锁时不运行预检Pod、不发布、不开repair flag。

独立controller制品从mono2已提交的完整`minisandbox/infra/cells` Git tree导出为
`infra/cells/`，不是记忆文件subset；source revision、tree ID和逐文件manifest随包校验。
北京管理模板的COS bootstrap relay只作content-addressed中转，按当前管理outputs选择，
不回退旧q01默认bucket/TCR。builder使用`/data`下revision+manifest绑定的immutable目录，
新wrapper在mint temporary push credentials前拒绝任意目录/错误revision或manifest。
push auth也只落`/data`，保留双cleanup和expiry；Go base必须匹配完整module graph。
候选OCI须完成registry digest冷拉和标签校验，再进入既有串行release路径。
制品准备不需要重编workerd，不变更Cell、RBAC或repair开关，也不证明TKE实际修复资格。

2026-10-04候选已通过实际Go build/test、TCR push和隔离缓存cold pull，见
[controller产品回执](../../deploy/tencent/fleet/controller/evidence/controller-product-03e7e7b7-20261004.json)。
TAT `inv-d9fh1a0su6` SUCCESS/0；source为mono2 `03e7e7b7`，制品尚未发布。
不能用本地Buildah manifest digest替代registry-reported digest；回执绑定后者。
原strict10k同supervisor仍持锁，A111/115、B4/4、active0；真实修复及完整Phase5仍未通过。

当前完整2757 release inventory复核发现上述初始Go candidate的base与目标lock不同。
同module graph不等于同foundation identity：实际`product-lock.py promote`拒绝该candidate，
不得因此放宽dependency closure或更新所有其他产品的foundation。新controller候选必须
使用目标完整lock的base；leaf晋级只改controller项并保留qualified runtime及其余全部metadata。
构建回执身份加入source、manifest、两base refs和unique tag的NUL分隔输入hash，拒绝覆盖
已有intent回执，避免同代码换base/tag时撞旧proof。receipt生成禁写Python字节码；派生cache
不是Git源文件，必须移出immutable closure后再完整复核，不能靠忽略extra files通过。

[匹配当前lock的controller回执](../../deploy/tencent/fleet/controller/evidence/controller-product-03e7e7b7-current-lock-20261004.json)
已通过真实Go build/test、TCR cold pull和28项完整inventory的leaf promotion；逐项对比仅
controller变化，其余27项与其他root metadata保持不变。这里只产生staged目标inventory，
没有更新Cell/GitOps、没有开启repair；实际TKE/Actor fencing与完整Phase5仍待执行。

strict10k supervisor的失败证据也必须fail closed：最终36h normal drain等待超时不能
因`set -e`跳过verifier，源码改为捕获该status、停并reap observer，再用已有输入生成
失败回执。verifier显式绑定load/cleanup/final-capacity三项exit status，任何非零拒绝
passed，即使输入receipt看起来成功或trace曾记录low。未产生/损坏的输入不能伪造为
完整receipt；只能留下nonzero终止日志。此修正不缩短正常缩容窗口、不强制缩容或释放
live workflow的锁，也不覆盖abrupt supervisor death。离线actual Bash故障测试不能
替代真实TKE缩容资格。2026-10-03T23:35:02Z原supervisor同InvocationID/PID仍live，
A111Hosts/115Machines、B4/4、active0；原load失败、cleanup通过与完整Phase5未通过不变。

真实TKE eviction primitive必须有独立显式入口，不能放宽local loopback门禁。
[受锁云入口](../../deploy/tencent/fleet/qualification/host-eviction-api/README.md)要求strict intent
绑定private HTTPS endpoint/context、kube-system UID、精确server版本、Ready/control Node
UID/provider ID、private callback IP、完整目标inventory的busybox digest和实际adapter哈希。
整个源码closure（含test/helper/verifier）校验后才允许Go-only测试；无显式intent的SKIP、
任意非零exit或缺少绑定intent SHA的完整回执都不能过门禁。fixture仅作用于自己的新
namespace，TLS/IP SAN、PDB与普通grace不放宽，cleanup按实际namespace/webhook UID，
回执O_EXCL新建0600拒绝覆盖，并检查测试期间Node UID不变。

共享fixture重构在本机1.35.5真实API复验通过（147.43秒、12 checks、正常cleanup），
本地entry仍保留原loopback/context/single-node限制。此时TKE入口仅source-prepared，
未在原supervisor持锁期间执行；callback可达性、实际1.30.0-tke行为、真实Actor fencing、
目的AZ容量和最终安全缩容均不能据此宣称通过。回执始终claimEligible=false，且未拦截
真实server内部condition/Delete窗口；API primitive不是controller/Actor admission。

该入口的committed `d2037c0e` Go subtree已完整冻结（1322 files），frozen副本race与
wrapper回归通过，并经当前management模板COS relay落地builder；
[源码准备证据](../../deploy/tencent/fleet/qualification/host-eviction-api/evidence/source-prepared-d2037c0e-20261004.json)
绑定archive/tree/manifest/exact destination及执行位。全部非测试Go源码与已构建controller
candidate相同，不重复构建controller/workerd。此证据仅source preparation，cloud fixture
未执行、claimEligible=false；原持锁supervisor及111Host缩容状态没有被改动。

执行前提检查发现builder没有native Go，容器内构建成功不能证明该入口可运行。
从同一locked Go base离线准备Go 1.25.4及经frozen module校验的cache后，builder原生
三项intent/target fake-client race回归通过、source manifest未变；
[工具准备回执](../../deploy/tencent/fleet/qualification/host-eviction-api/evidence/tooling-prepared-20261004.json)
保留exact SDK selector/hash与非资格scope。没有新runtime/controller构建、public下载或
真实TKE fixture；工具就绪仍不构成Actor fencing、缩容或Phase5资格。

- Worker Version、Deployment、GC 与 Durable Object storage identity 继续遵循
  `2026-08-31-workers-durable-objects.md`；
- Rivet Actor V1 ID、Guard peer forwarding 和未来迁移遵循
  `2026-08-23-actor-routing-identity.md`；
- VPC、CCN、私有 CLB、跨 Cell Gateway 和区域隔离遵循
  `infra/cells/deploy/tencent/fleet/network/ccn-plan.yaml`；
- 本文的 Object placement 不是 Actor migration route。第一阶段 Object 固定在初始 Cell；
- 本文确定普通 Worker 与持久 Object 的组合模型，并定义两者之间缺失的内网寻址层。
