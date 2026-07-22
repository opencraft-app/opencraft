# VelaGWSet Provisioner 设计

## 目标

把 LLMGateway MySQL 中持久化的 Set provision request 可靠地物化为
`VelaGWSet`，替代旧 set-manager 对 `LLMFleet.spec.sets[]` 的写入。容量
worker 只产生扩容意图，VelaGWSet Controller 只收敛 Kubernetes 子资源，
独立 `velagwset-provisioner` 负责二者之间的业务状态机。

## 边界与真源

| 状态或动作 | 唯一所有者 |
|---|---|
| 容量水位、Set ID、Shard、数据库名、Redis DB、Release | LLMGateway MySQL |
| Shard 主机、端口、凭据 Secret、连接池默认值 | Git/ArgoCD 管理的只读 Fleet 配置 |
| provision request 状态、writer backend/epoch、lease 和 Kubernetes evidence | LLMGateway MySQL |
| Set runtime Secret、数据库 bootstrap Job、`VelaGWSet` 初始 allocation/runtime 字段 | velagwset-provisioner |
| Deployment、Service、PDB、`VelaGWSet.status` | VelaGWSet Controller |
| new-api 初始化、渠道/定价/权益同步和准入 | LLMGateway control/worker |

Provisioner 不直接访问 LLMGateway MySQL。它只调用 internal control API，并通过
Kubernetes API 读取只读 Fleet/Shard 配置和被明确引用的 Shard Secret，创建临时
bootstrap Job、Set runtime Secret 和 `VelaGWSet`。Controller 继续不访问 control
API、MySQL 或 Redis。

每个 request 固化 `runtime_backend=llmfleet|velagwset` 和 `writer_epoch`。旧
`/api/internal/set-manager/set-provision-requests` 只能列出 `llmfleet` request；新
`/api/internal/velagwset-provisioner/set-provision-requests` 只能列出 `velagwset`
request。后端隔离由服务端强制，不能依赖调用者传 query。Fleet 切换 backend 时
递增 epoch；旧 epoch 只能完成或取消，不能被新的 writer 领取。

## 物化状态机

```text
pending
  -> provisioning
  -> created
  -> configured
  -> managed

任一步骤失败：
  可恢复错误保留当前非终态并写 last_error，后续重试；
  身份冲突或不可变字段冲突进入 error，禁止猜测式覆盖。
```

1. Provisioner 拉取 `pending/provisioning/configured` request。服务端 claim API
   提供 `owner/token/lease_until/attempt/version`；多副本只能有一个 owner 推进
   同一 request。Provisioner 的 renew/release、materialized 和 serving-ready 迁移
   必须携带 token、expected status/version、backend、writer epoch和 lifecycle
   revision，使用单条条件 UPDATE 完成 fencing CAS。
2. 对 `pending/provisioning` request，重新读取 request 当前状态和 Fleet 中对应
   Shard。校验 release image 为 digest、Redis DB 范围、数据库名和同名 CR 身份。
3. 先以 `managementPolicy=Observe` 创建 `VelaGWSet`，取得 CR UID，但不创建
   workload。request ID 的 SHA-256 摘要写 label，完整 ID 写 annotation；不得把
   包含特殊字符的完整 ID 用作 label value。
4. 创建幂等 database bootstrap Job。Job 使用 Shard Secret 的 admin 凭据创建
   request 指定数据库；名称包含 request digest 和 durable attempt。request 持久化
   Job UID/completion。失败 retry 递增 attempt，绝不复用已失败 Job 名。
5. 创建或校验 Set runtime Secret，并在 CR 创建后补充 owner reference。Secret 只
   包含该 Set 的 app DSN、Redis URL、session secret 和连接池参数；request 持久化
   Secret UID/identity digest，敏感值不得写入日志、request 或 CR spec。已有 Secret
   identity 不一致时进入确定性 error，不能输出内容 diff。
6. bootstrap 成功后把 policy 单向推进到 `Managed`。初始 generation 1 traffic
   replicas 为 0，Controller 只启动 admin。admin Ready 且 observedGeneration 收敛
   后，Provisioner 调用原子 materialized API：服务端在一个事务中以 provisioner
   token/version CAS `provisioning -> created`、保存 admin-only fact/outbox并释放
   request lease。admin-only fact 不含 runtime generation/route。
7. `reconcile_set_facts` worker 使用现有 worker job lease领取 admin fact，完成 new-api
   setup、root token、渠道包、倍率、定价和权益同步；成功后以 fact desired hash 和
   expected request version CAS `created -> configured`。此阶段不运行面向用户的
   admission，也不发布 traffic route。
8. Provisioner 看到 `configured` 后，把 generation 1 traffic replicas 改为目标
   副本数。`VelaGWSet Ready=True`、observedGeneration 对齐、所有 traffic 副本
   Ready 后，上报包含 generation、image、traffic URL、HA 和 desired hash 的
   serving fact。Provisioner 通过原子 serving-ready API 保存 fact/outbox并释放
   configured lease，不直接写 managed。worker 处理 fact并确认 runtime route/HA
   projection 已提交后，CAS `configured -> managed`。
9. `managed` 后 worker 执行公开 admission check。只有 request managed、serving
   fact ack 和 admission passed 同时满足，Set 才进入新租户候选集合。

为保持原有安全启动顺序，CRD 将 traffic replicas 下限从 1 调整为 0。副本为 0
表示 bootstrap 阶段，不表示可承载流量；PDB 只为副本大于 0 的 runtime 创建，
从正数降为 0 时必须删除旧 PDB。`AdminReady` 与 `Ready` 分开：AdminReady 只证明
admin workload 可用；Ready 只有全部声明的正副本 traffic runtime 可用时为真。
目标副本取 Fleet HA policy，不由 request 或 provisioner magic number决定。

## 幂等与冲突

- request ID 是物化幂等键；所有 Kubernetes 资源带 request digest label、完整
  request ID annotation、Set ID 和 immutable allocation digest。
- 同名 `VelaGWSet` 的 Fleet、Shard、database、Redis DB 或 release image 不一致
  时进入确定性 `error`，不 patch 不可变身份。
- runtime Secret 已存在时只允许 identity annotation 一致；不输出 Secret diff。
- bootstrap Job 成功可重复观察，失败保留 Job UID 和完成证据并允许显式 retry
  创建下一 attempt；成功 Job使用 TTL 清理，TTL 不删除 MySQL evidence。
- lease 过期后其他副本可继续；每次写 Kubernetes 前重新确认 request version、
  writer epoch 和 lifecycle revision，避免旧任务复活已取消或下线 Set。若
  Kubernetes 写成功后 cancellation 赢得 CAS，补偿流程只允许带批准删除该 CR，
  不允许继续推进。
- `managed` 是终态，不允许普通 provisioner 回退。CR 已 Ready 但状态回写超时，
  重试只补写 fact/status，不重复创建资源。

合法迁移固定为：`pending -> provisioning -> created -> configured -> managed`；
`pending/provisioning/created/configured -> error|cancelled`。`managed/error/cancelled`
均为终态，普通 status API 不能回退；retry 必须创建新 attempt并保留历史 evidence。
管理端旧的任意 `/status` 写接口不得用于 provisioner 状态机。

Actor 和 lease 固定如下：Provisioner 可 claim `pending/provisioning/configured`；
claim pending 时原子推进 provisioning，claim provisioning/configured 时保持状态。
Provisioner 只执行 Kubernetes mutation、materialized 和 serving-ready API。Worker
不领取 provisioner request lease；它依赖 MySQL worker job lease消费 durable fact，
并用 backend + writer epoch + lifecycle revision + expected status/version + fact
desired hash完成 `created -> configured` 与 `configured -> managed` 的服务端 CAS。
管理员取消使用独立 lifecycle revision CAS，
会使所有旧 provisioner token和 fact outbox失效。

## 字段级所有权

- Provisioner：不可变 allocation 字段、runtime Secret 引用、Observe -> Managed、
  初始 generation 1，以及 request 为 configured 时的 `replicas: 0 -> target`。
- Release/upgrade 状态机：managed 后的 admin image、traffic generations/image、
  代际副本和排空删除。初始 release image 是 generation 1 的校验证据，不是整个
  Set 永远不可变的身份。
- Decommission 状态机：decommission approval、CR DELETE 和业务 cleanup ack。
- VelaGWSet Controller：子资源和 status；无权推进业务 request。
- Observer/control worker：fact reconcile acknowledgement、`created -> configured`
  和 `configured -> managed`；Provisioner 不写 managed。

## 安全边界

当前一期沿用 Shard 级共享 MySQL app user 和 Redis 实例/DB 编号。它们是故障与
容量隔离，不是恶意租户之间的安全边界；new-api Pod 受平台信任。每 Set MySQL
用户和 Redis ACL 是后续纵深防御，不作为本次切换前置条件。

Provisioner 部署在 Fleet 专属 namespace。读取 Shard Secret 的 Role 只授予 `get`
并由 Argo 模板生成固定 `resourceNames`；不授予 Secret list/watch。动态 runtime
Secret 的 create/patch/delete 无法用标准 RBAC 按 label 约束，因此增加
ValidatingAdmissionPolicy：provisioner ServiceAccount 只能创建约定名称前缀且携带
Fleet、Set、request digest和 immutable identity metadata 的 CR/Secret/Job，并且
只能修改初始 allocation/runtime 字段集合；controller ServiceAccount 只能更新
`velagwsets/status`、它拥有的子资源，以及在主资源上单独增删
`gateway.lightvela.com/runtime-cleanup` finalizer；upgrade ServiceAccount 只能写 managed Set 的
admin image和 traffic runtime 代际字段；decommission ServiceAccount 只能写批准字段
并 DELETE。策略按 userInfo、operation、resource/subresource和 old/new object diff
分别校验，禁止任何 actor 修改 allocation identity。Admission 不读取 MySQL request
phase；生命周期授权由带 fencing token 的 control API 和 provisioner 状态机负责，
Kubernetes 策略只限制 actor、操作和字段 diff。Job 镜像固定 digest，关闭
service-account token，不接受用户命令，凭据只通过 secretKeyRef 注入，日志禁止
shell tracing，设置失败重试上限和 TTL。Provisioner 日志和错误上报只记录 Secret
名称/UID/digest，不记录 DSN、密码或 Secret data。

## 旧链路切换

1. 先部署 provisioner，但保持容量 worker 关闭；Fleet backend 切到 velagwset并
   递增 writer epoch。服务端从此不再向旧 endpoint 返回该 Fleet 的新 request。
2. OrbStack 以空 Fleet 验证 request 到 managed 的完整链路和重启恢复。
3. 不立即停掉整个旧 CronJob。服务端 backend 隔离会关闭它对 velagwset request
   的读取和写入；它只继续负责 legacy LLMFleet。原生 Fleet 显式设置
   `LLMGATEWAY_SET_MANAGER_UPGRADE_ENABLED=false` 和
   `LLMGATEWAY_SET_MANAGER_DECOMMISSION_ENABLED=false`。VelaGWSet 初始 fact、
   蓝绿 upgrade 和 decommission 都由常驻 provisioner 消费 control lease 后修改
   单个 CR；Controller 仍然只负责子资源收敛。
4. 北京创建一个人工 canary request；确认只出现 `VelaGWSet`，且
   `LLMFleet.spec.sets[]` 保持不变。
5. 在外部 ArgoCD 期望状态中保留旧 manager 但使用只允许 legacy backend 的
   scoped token；原生 lifecycle 默认关闭，只有对应环境 manifest 显式开启。
6. 确认旧 manager 的 legacy provisioning endpoint 对 velagwset backend 返回空，且
   新 provisioner 已持有当前 writer epoch 后开启 `reconcile_set_capacity`。
7. 触发最小水位 2，验证两个 Set 逐一 managed 后再允许正常自动扩容。

切换期间禁止新旧 writer 同时消费 provision request。代码中的 VelaGWSet
provisioner 不提供回写 `LLMFleet.spec.sets[]` 的兼容分支。

## 测试

- 单元测试：request 到 CR 映射、replicas 0/目标副本转换、identity conflict、
  lease/fencing CAS、旧 backend 不可见、重复 reconcile、状态单调、Secret 脱敏、
  Job attempt、取消竞争补偿和字段所有权。
- HTTP 测试：claim/renew/release、取消后的旧 lease、非法状态迁移。
- fake-client 测试：Observe CR、bootstrap Job、runtime Secret、owner reference、
  Managed 切换、AdminReady/Ready 分离、Green runtime 追加、指定代际排空、带 CR UID
  的下线许可、runtime 消失后才创建 cleanup Job，以及 serving fact evidence。
- OrbStack E2E：空环境创建容量缺口，自动得到 request、database、Secret、CR、
  admin bootstrap、traffic 扩容和 managed Set；中途重启 provisioner/controller
  不重复创建资源。
- 切换回归：旧 CronJob 可继续运行 legacy 职责，但无法列出/更新 velagwset
  request；`LLMFleet.spec.sets[]` 不变化，所有新增 Set 都有 `VelaGWSet` owner；
  失败 Set 不进入 admission，恢复后可继续。
