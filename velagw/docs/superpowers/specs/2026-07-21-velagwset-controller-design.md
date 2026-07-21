# VelaGWSet Kubernetes Controller 设计

## 目标

把单个 new-api Set 建模为 Kubernetes 原生资源 `VelaGWSet`，由常驻 Controller 独立收敛。Controller 不访问 LLMGateway MySQL、Redis 或业务 API；业务侧继续负责容量决策、Shard 分配、租户归属与流量路由。

## 所有权

| 数据或动作 | 唯一所有者 |
|---|---|
| Fleet 容量策略、SetClass、Release | Git/ArgoCD |
| Set ID、Shard、数据库、Redis DB 分配 | LLMGateway MySQL |
| `VelaGWSet.spec` 物化 | 业务侧 Set provisioner |
| Deployment、Service、PDB、runtime | VelaGWSet Controller |
| `VelaGWSet.status` | VelaGWSet Controller |
| 租户准入、Redis 路由切换 | LLMGateway control/worker |
| 运营状态投影 | LLMGateway observer worker |

## API

`VelaGWSet` 使用 `gateway.lightvela.com/v1alpha1`，scope 为 Namespaced，`metadata.name` 就是 Set ID。一个对象只表达一个 Set，启用 `/status` subresource。

身份字段在创建后不可变：

- `fleetRef`
- `shardRef`
- `databaseName`
- `redisDB`
- `runtimeSecretRef`

运行字段允许演进：

- admin/traffic 镜像
- traffic 副本数
- 业务侧明确要求保留的 traffic runtime generations
- Pod 资源与可用性策略

Secret 内容不进入 CR spec，只保存同命名空间 Secret 名称。Shard 连接信息由该 Secret 提供。`fleetRef`、`shardRef` 和 release revision 都是已经物化后的身份标签，Controller 不读取 Fleet、SetClass、Release 或 Shard CR，也不执行 Fleet 扫描。

OpenAPI schema 强制：

- `fleetRef`、`shardRef`、`databaseName`、`runtimeSecretRef.name` 必填且创建后通过 CEL 不可变。
- `redisDB` 范围为 0 到 255，创建后不可变。
- `managementPolicy` 只能为 `Observe`、`AdoptionPending`、`Managed`。
- `trafficRuntimes` 至少一个，以 `generation` 作为 list-map key，generation 必须大于等于 0且唯一。
- production 镜像必须为 digest；本地测试镜像通过单独的开发 CRD overlay 放宽。
- Secret 引用只允许同命名空间。

`status` 使用标准 Conditions，并至少表达 `Ready`、`Progressing`、`Degraded`、`DeletionBlocked` 和 `Adopted`，同时记录 `observedGeneration`、admin Ready 副本及每个 traffic generation 的期望/Ready 副本。Controller 不在 status 中宣称哪一代已切流。

## Controller

Controller 作为两个副本的 Deployment 运行，启用 leader election。它使用 informer/workqueue，由单个 `namespace/name` 作为 reconcile key，不扫描全 Fleet。

每次 reconcile：

1. 读取一个 `VelaGWSet`。
2. 若存在 `deletionTimestamp`，进入受保护删除流程，绝不创建新资源。
3. 正常对象若缺少 Finalizer，先写入 Finalizer并立即返回；写成功前禁止创建任何子资源。
4. 校验必要字段。Controller 不读取 runtime Secret；kubelet 解析 `secretRef`，Secret 缺失会通过 workload Ready 状态暴露。
5. 按 `managementPolicy` 观察、接管或创建/修复 admin 与所有声明的 traffic runtime。
6. 汇总子资源状态并更新 `status`。
7. 失败时通过 workqueue 指数退避重试。

Controller 不执行长时间 sleep；它只通过状态和 `RequeueAfter` 等待 Kubernetes 子资源 Ready 及 API 重试。业务探针、切流和排空由业务状态机推进。

Controller watch `VelaGWSet` 及其 owned Deployment、Service、PDB；子资源事件通过 OwnerReference 映射回单个 Set。它没有 Secret 读取权限。status 更新必须比较旧值，避免自激循环。

## 运行代际协议

Controller 不访问 Redis，因此不判断 active、promotion、drain 或 rollback。业务升级状态机负责探针、Redis revision CAS、切流确认、排空截止时间和回滚决策。

业务侧通过 `spec.trafficRuntimes[]` 明确声明当前必须保留的全部 generation。Controller 为每个 generation 创建独立 Service、Deployment 和 PDB，并在 `status.trafficRuntimes[]` 逐代报告 Ready。业务侧只有在 Redis 切流完成且排空期限到达后，才从 spec 删除旧 generation；Controller 随后删除这一代资源。

现有业务 cleanup worker 继续负责数据库清理、Redis DB 释放和 cleanup ack。Kubernetes Finalizer 不替代该协议。在 cleanup worker 替代链路完成并验证前，不删除旧 `cleanups[]` 执行能力。

## 创建与恢复

业务侧在 MySQL 中完成幂等分配后创建 `VelaGWSet`。数据库事务和 Kubernetes API 之间通过现有 provision request/outbox 恢复：只有 desired lifecycle 为 `provisioning/managed` 的记录在 CR 缺失时可以重建。`decommissioning/deleted` tombstone 永远禁止重建。

下线前，业务侧必须在同一 MySQL 事务中把 desired lifecycle 单调推进到 `decommissioning`、递增 lifecycle revision，并取消或失效该 Set 所有旧 provision outbox；随后才能写删除批准并发起 DELETE。Provisioner 每次重试都重新读取当前 lifecycle/revision，不能只信任 outbox payload。只有 CR 已消失且业务 cleanup ack 完成后才推进为 `deleted`，该状态不可逆。

遇到同名 CR 正在删除，或不可变 spec 与 MySQL 快照不一致时，provisioner 停止并记录确定性错误。Observer 只允许执行 `configured -> managed`，并且必须同时看到 `Ready=True`、`status.observedGeneration == metadata.generation`、全部声明的 traffic generation 及目标副本 Ready；其他原状态不得因为 CR Ready 自动跳转。

Controller 重启后只根据 `VelaGWSet.spec` 与实际子资源继续收敛，不依赖之前执行进度。

## 接管现有 Set

接管使用 `Observe -> AdoptionPending -> Managed` 三阶段，不能仅依赖一个布尔 annotation。

1. `Observe`：只读取现有资源，把 kind/name/UID、pod-template hash 和关键 selector 写入 `status.adoption.inventory[]`，不写资源。
2. 旧 set-manager 在 MySQL 保存 Set exclusion 与单调 `fenceRevision`；之后每一次资源写入前都必须重新检查 exclusion。业务侧等待最后一次执行和 lease 到期。
3. Provisioner 计算 inventory digest，在 `spec.adoptionHandoff` 写入 token ID、CR UID、inventory digest 和 fence revision，并将 policy 改为 `AdoptionPending`。
4. Controller 只有在 token、CR UID、inventory digest、fence revision全部匹配，并且现场 UID/hash 未变化时才接管；任何漂移都拒绝。
5. 校验通过后只补充 Controller OwnerReference和管理标签，不修改 Pod template，记录 token 已消费并写 `Adopted=True`。已消费 token不能用于新的资源 UID。
6. 业务侧确认后将 policy 改为 `Managed`，Controller 才开始修复 workload spec。

共享资源、冲突 OwnerReference、UID 漂移或关键配置不匹配时标记 `Degraded`，不得强制覆盖。第一期本地闭环只启用新 Set 的 `Managed` 路径和老 Set 的 `Observe` 路径；完整 adoption fence 在替代旧 writer 前实现。

## 删除

Set 不自动缩容。业务侧删除 CR 前必须完成：停止准入、用户清空、Redis 路由撤销和业务删除批准。`spec.decommissionApproval` 包含 request ID、attempt、批准时间、CR UID 和不可变身份摘要；该字段写入后不可变，且 RBAC 只允许 provisioner ServiceAccount 写入。

Kubernetes `ValidatingAdmissionPolicy` 在 DELETE 阶段检查 `oldObject`；未携带与当前 CR UID及不可变身份匹配的批准记录时直接拒绝 DELETE，因此正常对象不会获得 `deletionTimestamp`，Controller 可以继续自愈。该策略不引入 webhook 服务、证书或额外网络依赖。若绕过 admission 后出现无效批准但已有 `deletionTimestamp` 的异常状态，Controller 必须保留 Finalizer、停止删除并告警；此时只保证不主动清理，不承诺继续创建资源。Break-glass 只授予集群管理员并要求显式 UID。

批准后，Controller Finalizer `gateway.lightvela.com/runtime-cleanup` 只删除 OwnerReference UID 等于当前 CR UID 的已知 Deployment、Service 和 PDB。未知同名对象、共享对象或冲突 owner 必须拒绝删除。删除采用幂等 NotFound、冲突重试和 foreground propagation；确认完整资源清单消失后才移除 Finalizer。Finalizer 长时间卡住需要指标、告警和人工恢复说明。

## ArgoCD

ArgoCD 管理 CRD、Controller、Fleet、SetClass 和 Release。动态 `VelaGWSet` 由业务 provisioner 创建，不携带 ArgoCD tracking ID；AppProject 忽略该 Kind 的 orphan warning。

## 迁移

1. 安装 CRD 和 observe-only Controller，新 provision/upgrade/cleanup 仍走旧路径。
2. 只为无在途 provision、upgrade、draining、cleanup 的稳定 Set 回填 CR，并记录旧资源 UID。
3. 选择一个 Canary Set，在旧 manager 建立 Set 级 exclusion fence并等待 lease 结束。
4. 通过 handoff token 完成 `AdoptionPending`，校验无 rollout 后切到 `Managed`。
5. 接管完成前失败时移除新 OwnerReference/管理标签、作废 token并恢复旧 manager exclusion。进入 `Managed` 后不能简单恢复旧 writer，必须执行对称的反向 handoff 协议。
6. 逐 Set 接管，新 provision request 改为创建 CR。
7. observer 改读新 CR，确认没有在途旧操作后停止旧 CronJob 的资源执行职责。
8. 只有替代升级和 cleanup 链路全部验证后，才移除 LLMFleet 的聚合数组。

## 本地验收

OrbStack 必须自动验证：

- 使用固定 digest 镜像和 Secret fixture，创建 `VelaGWSet` 后 360 秒内真实 new-api admin/traffic Ready。
- 删除一个 owned Service 后 30 秒内 Controller 自动恢复。
- Controller 在 Finalizer 写入前重启，不得留下无 Finalizer 子资源；在创建、Ready 和删除阶段重启后均继续收敛。
- Observe/AdoptionPending 下用 Deployment generation、pod-template hash、ReplicaSet 和 Pod UID 证明没有 rollout；冲突 OwnerReference和 UID 漂移必须拒绝接管。
- 未批准 DELETE 被 `ValidatingAdmissionPolicy` 拒绝，CR 和资源持续 Ready；绕过 admission 制造异常 deletionTimestamp 时 Controller 保留 Finalizer且不主动清理。批准后按 CR UID 验证完整子资源在 60 秒内消失。
- 用 NetworkPolicy 拒绝 Controller 到 MySQL/Redis 的 egress，删除 Service 后仍能自愈。
- 两副本 leader failover 后 30 秒内继续 reconcile。
- 旧新 writer fence、provision tombstone 和在途 upgrade/cleanup 迁移均有独立回归用例。
