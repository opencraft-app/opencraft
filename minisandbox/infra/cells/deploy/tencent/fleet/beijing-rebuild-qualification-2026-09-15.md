# 北京 clean-room 重建阶段证据

本记录是本次重建的阶段证据，不是完整 Fleet 开放或容量承诺。云资源 ID
只用于关联这次观测，下一次构建必须从 Terraform output 和新 Claim 重新取得。

## A 初始资格与中央采纳

新建管理 C `cls-b2lt3ed9`、Cell A `cls-kuck099x`。A 的主 FDB UID 为
`eef9ba91-78d3-46dd-b814-b1d2d01b61c6`，Cell UID 为
`9926758e-4147-43ae-ae8c-38247f985bd8`。

| 阶段 | 本次结果 | SHA256 |
| --- | --- | --- |
| Bottomless production-cell | 48 Objects、6240 writes、checkpoint/sleep/cold-wake/cleanup 通过 | `9c76e6b500c2dc262ff0f2574b929e758264a3877d23f9f21a70fc9a6c13120f` |
| Engine HA | 精确删除一个 Engine Pod，1500 次公共 `/v1` 请求零失败，三可用区恢复 | `23b2022c4e300e89d538bfaa76ad6b65fc7b2d3f8609a3c54009ae9be10223bc` |
| 初始资格链 | Terraform、平台、Argo、初始工作流、审计/control 精确身份汇总通过 | `2aaca30d03627b69af42d4f5fd5c6e4087ddebc0e44f2846b2e04708f9efb0de` |
| 正式激活 | 2026-09-15T09:24:45Z 后，desiredState=Ready、readyForPlacement=true | `8d1ef04209f3c6943ff59b7abd4a565d0ae85457260f16c5f5e8da0b9b4998f3` |
| 中央采纳 | 精确 Claim/Pool/Cell UID 绑定通过 | `e38e5b5f52fbc50c091d4f87c86ea0ce2333c5aef11975d18546a621fb2073cd` |
| route v2 | 采纳后发布通过 | `b8b8f6dda1b6822554c167bacf7e6af853abb64b013d69924024d90ac4957271` |

真实物理恢复至独立目标 `actor-bj-a01-dr-initial-20260915`，目标 FDB UID
`a70bf597-6368-4649-9e71-dc13d8f112fa`，恢复版本 `5102459544`。
12 个对象状态精确一致，SQLite integrity_check=ok，COS 冷对象可读。
最终审计/control 均 passed，control=allow，无失败或警告。
恢复目标暂时保留；清理仍须单独验证精确资源与存储所有权。

## 证据边界与下一步

- 冷恢复测试显式设置测试数据库 retention override，并使用生产回收周期
  600000 ms。不是默认七天 retention 的自然冷降时延证明。
- 冷唤醒 p95=1179.78 ms、p99/max=4784.76 ms。通过本次资格门，不能宣称
  全平台每个 Agent 都在 3 秒内可聊。
- B 已独立完成平台、Argo、连续备份、初始资格和物理恢复，再正式激活、
  中央采纳并发布 route。具体收据见后文，不使用 A 的结果代替 B。
- 中央公共 `/v1` 的首次真实 placement、public admission chain 与 Argo
  desired state 已完成；中央观测平面已完成下述 Argo/federation 门。
- 本次新 A/B 的完整负载驱动扩缩容、自动修复和大规模容量仍须独立证据，不能
  复用历史 q01 收据作为当前部署的通过结果。

安装采用已归档的 28 项不可变镜像，没有重新编译 workerd。A 初始资格固定
完整源树 `78fed06efe8465eaa3026cc935a4fad9b2732166`。B 使用包含后续离线
chart 前置验证修复的完整源树 `c28c9022dd234477241293dab9bf59ee2f7b29d4`
安装平台；后续 runtime/资格固定完整源树
`e6df7f8517de1cb32bbd99b78c66361dacb4287d`，包含控制池拓扑前置检查。
各源树分别校验完整 per-file manifest，不在已运行资格的源树上追加补丁。

## B 控制池 bootstrap 拓扑缺陷

2026-09-15T10:02Z，实际 16 个 Node Ready 并不等于控制池合格。
控制池 `np-control0` 为 `2/0/1`，尽管其配置为 `ZoneEquality`、
Ready replicas=3。NATS 的第三个成员被硬三可用区反亲和规则正确拦截。
runtime invocation `inv-e8p2f3g809` 因 NATS 等待超时 FAILED/exit 1；
没有正式 runtime release，也没有开始 Engine/Actor。

- 修复 control/runtime pool installer 的超时路径：必须保留 actual Node
  topology 验证通过的结果，不能仅以 MachineSet Ready 数量成功退出。
- runtime 安装在 auth Secret、node admission 和 workload 变更之前增加
  Cell-local 控制节点只读拓扑检查；不放宽 NATS/Engine HA 约束。
- 新回归在原归档源码上确定性复现了两种 installer 的错误成功；修复后
  4 个 CLI 测试方法通过，覆盖两种池的 8 个场景。新增 runtime 前置验证
  5 个测试方法、已有 runtime 分阶段安装 6 个测试方法及 admission manifest
  contract 均通过，没有重编译 workerd。
- 仅选没有 NATS、FDB、runtime host 或 PVC 的重复区控制节点，以精确
  Machine UID/resourceVersion 删除，由 TKE 完成退役/补齐。每次删除前持久化
  计划，共最多 2 次，不删 Pod、Node、PVC 或 CVM。第一次替换仍落在重复区。
- B 的同规格机型候选配置通过正式 Git/Argo CAS 更新，追加
  `SA5.2XLARGE16`，不变更 Cell JSON、主 FDB UID、A 的 Argo revision
  或 runtime 镜像。第二次替换已创建 `ap-beijing-7` 节点，机型仍是
  `SA9.2XLARGE16`。不能据此宣称先前是库存不足或备选机型解决了根因。

这属于 pre-admission bootstrap 修复，不是生产自动 Machine repair 资格。
随后已观察实际控制节点为 1/1/1、全部 Ready，NATS 3/3 Ready；独立 B 资格
及物理恢复已取得后文收据。A/B 私有 Engine 和监控 federation 入口本身
不证明公共入口，公共入口由独立 HA/placement/admission 门验证。

## B runtime 与中央观测收敛（10:35 UTC 阶段历史）

- B runtime 仅恢复失败后的阶段，`inv-c8p3e90sn4` SUCCESS/exit 0。
  三 Engine 实际连接 NATS，三个 workerd Host Ready；Registry binding 与首次
  static release 通过。release 收据 SHA256
  `d28b9cd148489e3d40c22ca8038c43007286aac5b4f825836f1e3b8966b15d31`。
- B 监控安装完成后，首个 verify 在 workerd scrape 收齐前失败。实查三个
  Host targets 均 up、lastError 空；只恢复完整 verify，不重装监控、不忽略
  失败项。`inv-a8p3m0g4hj` SUCCESS/exit 0。修订
  `f3e10ff1e54da47af5d313bc800f084864a23822` 为 workerd 增加与 Engine 一致的
  有界 scrape 等待；四条 Bash query-double 回归覆盖已健康、延迟收齐、持续
  缺副本及无工作负载。后两项仍 fail closed；没有重编译镜像。
- B 私有 Engine 与 federation 入口均已取得本轮真实身份收据。B 初始资格
  `inv-e8p3nt0j19` 已开始，不把启动任务或 runtime Ready 当作资格通过。
- C Hub Prometheus/Grafana、A/B bounded federation 和 Argo 采纳均已通过，
  `inv-c8p3psg35f` SUCCESS/exit 0。Application Synced/Healthy，Git
  `36298ca3156ab052fe9740a033acae9d29596695`，资源 UID 保持、自愈漂移验证通过；
  desired Git 没有 Secret。四个观测 Pod 均 Ready。
- Hub 只汇聚 Cell/compute-node 录制规则，并已验证心跳、容量、身份去重与无
  原始高基数指标泄漏。中文面板已安装，但 Grafana 仍为 ClusterIP，需要
  内网入口或临时 port-forward；Alertmanager receiver 未配置，不能宣称有
  外部告警通知。公共 Workers API 及最终业务 placement 仍未完成。

## B 独立资格与中央采纳（11:12 UTC）

B 为 `cls-1femn3mh`，VPC `vpc-3m6m3j6s`，网段 `10.162.0.0/20`；
Cell UID `87a07636-737c-4a57-8693-9d02f61883f8`，主 FDB UID
`c6e52dcb-1a7b-499b-bf36-39e8fe2194dd`。独立工作流 `inv-e8p3nt0j19`
终态 SUCCESS/exit 0；没有重跑整个 bootstrap 或重编译 runtime。

- Bottomless：48 Objects、6240 writes，checkpoint/sleep/cold-wake/cleanup
  通过。生产回收周期等待 640149 ms；测试数据库 retention override 与 A
  相同，不能当作默认七天 retention 的自然冷降证明。
- Engine HA：10 并发、1500 个公共 `/v1` 请求，单 Engine Pod 删除后失败 0。
- 独立恢复目标 `actor-bj-b01-dr-initial-20260915`，FDB UID
  `90cca9f8-0731-4d22-ba4d-e4c4c98d313d`，最终恢复版本 `4502621684`；
  12 个对象精确一致、SQLite integrity_check=ok、COS 冷对象可读。
  三个可用区各一个恢复 agent，验证后全部缩为 0、源测试对象已清理。
  目标保留三个 storage PVC，后续只按精确身份单独审阅清理。
- 完整资格链 SHA256
  `d4e87a17032051f88ef646c3ba44faef014ef34bef7a3d940668e6c53a61a526`。
- 正式激活 `inv-a8p4v3gt2m` SUCCESS/exit 0；激活 SHA256
  `68d061e6dacd671a1d1f029855d6d7636fe5214e49ee6d399ded8b3a3e33870a`。
- 中央 Claim 精确身份采纳与 route 发布 `inv-c8p4vvgvpn` SUCCESS/exit 0；
  adoption SHA256 `084a90a4d6e7b9189a5ead879334f82c35fae9d10a085037bfd17b791bacd499`，
  route SHA256 `89d8b7f29055a123014837210dc44cd926d4648c22b1635eef2cb58d0b2a247f`。

B 冷唤醒 p95=1154 ms、p99/max=3827 ms，通过本次资格门；不是 3 秒产品
SLO 或百万对象/万级活跃容量的承诺。

## C 公共入口与 Argo 收敛（11:16 UTC）

复用现有 Workers API digest，三副本位于 C 的三个控制节点；公共私有入口
`http://10.160.0.3:6688/v1`，CLB `lb-61ahe91p`，Service UID
`3d9df108-0132-40ea-94f8-53d334e01f9e`。地址仅是本轮 Terraform/Kubernetes
输出，不能作为下次 bootstrap 的固定输入。

| 门禁 | 本轮结果 | SHA256 |
| --- | --- | --- |
| Private endpoint isolation | C 同 VPC ready 前后成功，A/B 两个独立 VPC 无 HTTP 响应；实查 exact CLB/VIP/SG/listener | `9ea1977fa309b8f41a2d44609816f9bbee85b2027ce2a1efd45648e4ae4c3ee5` |
| API Pod replacement HA | 1123 次成功请求，替换窗口 1092 次，失败 0 | `173f12cc014943f006a1aa7f06d4ef5b61918b1cc7d0b93d1e0c90f0c73c2c08` |
| First placement | 实际上传/部署/调用 QualificationAgent，按 Registry 真值关联实际选中 Cell；不是 Counter 持久化测试 | `ab604d2809335af412fc98f6a1423dc13fbf6a5f8e71bda98c8ca31843a76b59` |
| Public admission chain | 两 Cell route/convergence、独立 Registry binding、可恢复 Code Plane、安装/隔离/HA/placement 精确关联 passed | `5e341776e232bdead80f0cd3480931b4ffd8151e01392563a55b7f5608708726` |
| API/CLB Argo adoption | Synced/Healthy、UID/VIP/Secret 身份保持、无 Secret Git、自愈及 A/B Application 未变 | `6f1f43253d1db81e1db524e5403e912736eeacc1bef4bf30c232d3e4e0762e25` |
| Public Counter | 仅公共 `/v1` 上传/部署/创建，1/2/3 递增、原始 origin 保持、Object DELETE 幂等、Worker DELETE 409 保护 | `69b81d02624d34a11f6f57e8309abdfd090c3ddbc9e7dd833454b12850169d6a` |

Argo Git revision `0ae27133d577acbac8f9a94ecbc7038e1049743f`。API/CLB 的
bootstrap 根由现有安装流程产生，随后采用已有 GitOps renderer/publisher/
Application 门禁正式采纳；不向 Git 提交凭据。不是新写的 reconciler。

Counter 首次测试误把 DELETE Worker 预期设为 204，收到协议规定的
`409 worker_has_durable_objects`，该次测试 FAILED。更正测试预期后
`inv-c8p516g22t` SUCCESS/exit 0；没有修改服务端、强删 namespace 或绕过门禁。
Object 已销毁，少量测试 Worker/关联 namespace 保留，不能宣称已完全清空。
Counter 测试本身未执行 Host replacement；持久恢复证据由独立 A/B 初始
资格提供，不能混为同一次故障测试。

公共 admission、Argo convergence、Counter 与 B adoption/route 的压缩收据
SHA256 `ec2b2e7e5be19adade4437986401ef440e14b8dad841c69df7605a36a54ffb9d`。
本地操作目录 `/data/actor-rebuild/beijing-rebuild-20260915` 保存本轮保护输入、
串联脚本、immutable TAT invocation 和收据；不是一个命令无人参与的重建。

### 仍未宣称完成的能力

- 从 IDC 调用机直接连腾讯云 VPC 的网络授权与路由；当前机通过配置的
  management kubeconfig 连接私有 API `10.160.0.7` 仍收到 TLS access denied。
  本次公共门禁/Counter 在 C VPC 的合法调用机运行，不以 IDC 网络可达性
  作为 Cell ready 条件，不绕过网络授权。
- 本轮新 A/B 完整负载驱动 TKE 扩缩容/生产自动 Machine repair 资格；
  targeted repair 和 exact scale-down 开关仍保持关闭。
- Grafana 外部入口和 Alertmanager 通知接收端；当前仅内部观测可用。
- 长时间 soak、大规模容量和全部请求 3 秒内可聊的性能承诺。

## 2026-09-25 永久重建资格链补录

后续产品演进保留了原 clean-room 构建身份，并把此前散落的阶段收据关闭为
`actor-fleet-rebuild-qualification/v1`。当前 Workers desired-state Git revision
为 `6cbdfe96e2c92c2908dc68b054ee5f8239b38047`；工作负载 manifest 与上一修订
逐字节相同，没有重编译 workerd 或滚动 Pod，但 Git 树新增并绑定了精确
`workers-api-render.json`，不再依赖已经消失的 operator scratch 文件。

最终收据同时验证：C Code Plane clean-room chain、A/B qualification 与当前
identity/serving route、历史 first placement 与 CLB Pod replacement、当前
Workers/observability Argo convergence、Router metrics、A/B stateless Native
NodePool 扩缩容、C Router 扩缩容及 deployment cursor p99。生成时重新读取
live ShardPool、两个 RivetCell、四个 route ConfigMap、Workers Deployment/HPA
和 Argo Application；当前仍为两个 Ready Cell、Workers 三副本，Deployment
UID 未改变。

- receipt：`/data/actor-bootstrap/beijing-rebuild-20260915/receipts/fleet/rebuild-qualification-05f46f712.json`
- SHA-256：`8f8534ef0efd205dc1c380568009d9dc286e091aad8a9d53f435ed693ac32775`
- verifier source SHA-256：`ce7c357c4148b72db65cbada848bafb6ccaee549c2f8ca64f35314e2d0a84883`

A 仍使用升级前、携带四个精确 evidence digest 的 immutable route payload，B
使用解耦后的稳定 route payload。验证器只接受这两种逐字段完全匹配的格式；
新 publisher 只生成稳定格式。没有为统一外观而删除 A 的不可变 ConfigMap，
因此没有人为制造路由缺口。
