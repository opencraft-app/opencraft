# 控制面 OpenTelemetry 可观测性设计

## 目标和边界

第一阶段为三条长期运营关键链路提供统一观测：

1. Set 生命周期；
2. 租户准入和权益；
3. 配置一致性。

MySQL 中的业务、任务和状态机记录仍是唯一事实源。遥测只用于告警、检索和链路分析，
不参与业务恢复、幂等判断或状态推进。本期不覆盖 `/v1/*` 模型流量，不引入审计系统，
不记录模型正文。

应用向 stdout 写单行 JSON，TKE/CLS 直接采集。本设计不把 stdout 称为 OTLP transport：
每行是一个按 OTLP protobuf JSON mapping 编码的 `TracesData` 或 `LogsData` payload，外层
分别以 `resourceSpans` 或 `resourceLogs` 区分信号。这是项目约定的 OTLP-payload JSONL
framing，不使用 OTLP/gRPC 或 OTLP/HTTP，也不部署 Collector。

## 观测模型

采用“操作 Span + 状态事件 LogRecord”：

- 一次有明确起止时间的同步操作或状态机 attempt 产生一个 Span；
- 一次需要长期检索的已提交状态变化、重试或失败产生一个 LogRecord；
- 同一进程内且存在有效活动 Span 时，LogRecord 复制其 trace ID、span ID 和 flags；
- 无活动 Span 时省略关联字段，绝不生成假的 trace/span ID；
- 跨进程、跨重启和持久任务边界创建新的 root Span，通过持久化的 run/request/task ID
  关联，不持久化 trace context，也不承诺一条 Trace 跨越整个异步状态机；
- 直接 HTTP 调用使用 W3C Trace Context 提取和注入，立即下游调用保留同一 Trace；
- worker 每个 batch/attempt 建 Span，不为扫描得到的每一行建 Span。

不采用仅 Span 方案，因为状态机跨重启后无法复盘；不采用遥测 outbox，避免遥测成为
业务依赖。事实提交到遥测进入内存队列之间存在允许丢失的 crash window，交付语义是
best effort，不是 exactly-once 或 lossless。

## stdout 协议和 Go Pipeline

### JSON 编码

每行只含一个 span 或一个 LogRecord 对应的完整 payload envelope，禁止一个 envelope
包含多个记录。这样 CLS 中一行只对应一个 trace ID 和一个业务事件。

编码严格遵循 protobuf JSON mapping：

- 字段名 lowerCamelCase；
- enum 使用数字；
- `int64`/`uint64` 使用十进制字符串；
- trace ID 为 32 位小写十六进制，span ID 为 16 位小写十六进制；
- 属性使用 OTLP `KeyValue`/`AnyValue`；
- 不增加 OTLP schema 之外的顶层字段；
- 每行以换行符结束，禁止 pretty print；
- 单行硬上限 32 KiB，超过时先截断已脱敏错误摘要和可选属性；仍超限则丢弃该记录并
  增加 drop 计数。

### 依赖和组件

第一期固定使用：

- `go.opentelemetry.io/otel`、`otel/sdk`、`otel/trace` v1.43.0；
- `go.opentelemetry.io/otel/log`、`otel/sdk/log` v0.19.0；
- `go.opentelemetry.io/proto/otlp` v1.10.0；
- `google.golang.org/protobuf` v1.36.11。

实现两个自定义 exporter，将 SDK `ReadOnlySpan` 和 `log.Record` 转换为上述单记录 OTLP
payload。Trace/Log exporter 共用一个带 mutex 的行写入器，保证并发写入不交错。
`stdouttrace`/`stdoutlog` 仅用于调试，不能用于生产输出。

Trace 使用 `BatchSpanProcessor`，Log 使用 Logs `BatchProcessor`。生产默认值：

- 每个 signal queue：1024；
- 最大 export batch：64；
- batch timeout：1 秒；
- export timeout：5 秒；
- shutdown/flush timeout：5 秒；
- 单记录上限：32 KiB；
- control、worker、set-manager sampler：AlwaysOn。

exporter 入队不能阻塞业务。queue full、编码失败、超限和写失败分别累计原子 drop
counter。每 60 秒和 shutdown 时由一个不经过被测队列的后台路径尝试直接写入标准 OTel
LogRecord `llmgateway.telemetry.dropped`；该路径只能阻塞后台 goroutine，不能阻塞业务。
control 同时在 `/metrics` 暴露无高基 label 的 drop counter。若 stdout 本身永久阻塞，
进程内无法可靠报告丢失，最终由 5 秒 shutdown timeout 保护退出。

Go 普通 `log` 保持 stderr；当前非 OTel 日志和 traffic access log 不混入 OTel stdout
数据流。traffic 不在本期启用 OTel。

## CLS 检索契约

CLS 按 JSON 模式采集 stdout，保留整行原文。因为每个 envelope 只有一条记录，固定路径为：

- Trace ID：`resourceSpans[0].scopeSpans[0].spans[0].traceId`；
- Span name：`resourceSpans[0].scopeSpans[0].spans[0].name`；
- Log Trace ID：`resourceLogs[0].scopeLogs[0].logRecords[0].traceId`；
- Event name：`resourceLogs[0].scopeLogs[0].logRecords[0].eventName`；
- Log attributes：`resourceLogs[0].scopeLogs[0].logRecords[0].attributes`；
- Resource：对应 `resourceSpans[0].resource.attributes` 或
  `resourceLogs[0].resource.attributes`。

每个状态/drop 事件必须设置标准 `LogRecord.eventName`；`body` 只放可选的脱敏摘要，不能
承载事件身份。CLS 为 trace ID、span/event name、service name 和 severity 建 JSON 索引。OTLP attributes
是 `KeyValue` 数组，内部 user ID、Set ID 和 run ID 第一期使用整行精确词检索；验收查询
同时限定 event name 与完整属性值，不能只做模糊前缀。若后续需要属性列化，应在 CLS
采集侧增加转换，不在 OTLP payload 顶层复制自定义 alias。

## Resource、Scope 和配置

每条记录包含：

- `service.name`；
- `service.namespace=llmgateway`；
- `service.version`；
- `deployment.environment.name`；
- 可用时包含 `k8s.cluster.name`、`k8s.namespace.name`、`k8s.pod.name`、
  `k8s.pod.uid`、`k8s.container.name` 和 `cloud.region`。

Instrumentation Scope 固定为：

- `llmgateway/set-lifecycle`；
- `llmgateway/tenant-entitlement`；
- `llmgateway/config-consistency`；
- `llmgateway/telemetry`。

生产进程名称：

- `llmgateway-control`；
- `llmgateway-worker-core`；
- `llmgateway-worker-admin`；
- `llmgateway-worker-byok`；
- `llmgateway-worker-observer`；
- `llmgateway-worker-maintenance`；
- `llmgateway-set-manager`；
- `llmgateway-runtime-cleaner`。

环境变量：

- `LLMGATEWAY_OTEL_STDOUT_ENABLE=false`；
- `OTEL_SERVICE_NAME`，未设置时按进程/worker pool 推导；
- `OTEL_SERVICE_VERSION=dev`，生产必须注入镜像 Git commit；
- `LLMGATEWAY_ENVIRONMENT=local`；
- `LLMGATEWAY_OTEL_QUEUE_SIZE=1024`；
- `LLMGATEWAY_OTEL_BATCH_SIZE=64`；
- `LLMGATEWAY_OTEL_BATCH_TIMEOUT=1s`；
- `LLMGATEWAY_OTEL_EXPORT_TIMEOUT=5s`；
- `LLMGATEWAY_OTEL_SHUTDOWN_TIMEOUT=5s`；
- `LLMGATEWAY_OTEL_MAX_RECORD_BYTES=32768`；
- `LLMGATEWAY_OTEL_HASH_KEY` 和 `LLMGATEWAY_OTEL_HASH_KEY_ID`；
- `K8S_CLUSTER_NAME`、`K8S_NAMESPACE_NAME`、`K8S_POD_NAME`、`K8S_POD_UID`、
  `K8S_CONTAINER_NAME`、`CLOUD_REGION`。

显式环境变量优先于推导值。非法数值或 duration 在启动时失败，不能静默回退。生产模板
为 control、全部 worker、set-manager 和 runtime-cleaner 开启；Kubernetes Resource 通过
Downward API 注入。set-manager 和 runtime-cleaner 新增与 app 相同的 setup/flush 生命周期。
traffic 保持关闭。

旧 `llmgateway.user_id` 等下划线属性一次性迁移到本文点号命名；不双写旧属性。

## 字段、安全和错误

### 公共业务字段

- `llmgateway.user.id`：内部 user ID，租户和权益链路必须明文记录；
- `llmgateway.set.id`、`llmgateway.shard.id`、`llmgateway.plan.id`；
- `llmgateway.external_key.id`；
- `llmgateway.run.id`、`llmgateway.request.id`、`llmgateway.task.id`；
- `llmgateway.entity.type`、`llmgateway.entity.id`；
- `llmgateway.state.from`、`llmgateway.state.to`；
- 可用时记录 `llmgateway.transition.version`；始终记录
  `llmgateway.transition.time`、`llmgateway.transition.writer`；
- `llmgateway.attempt`；
- `llmgateway.outcome`：`success|failure|retry|noop|conflict|blocked|unknown`。

HTTP、数据库和错误信息使用 OTel Semantic Conventions，例如 `http.request.method`、
`http.response.status_code`、`server.address`、`db.system.name`、`db.operation.name` 和
`error.type`。禁止记录 URL query、header、`db.query.text`、请求/响应 payload。

### 脱敏

所有 Log body、eventName、attributes、Span attributes、Status description 和 exception event 在写入
SDK 前经过同一个 sanitizer。禁止直接调用 `RecordError(rawErr)` 或把 `err.Error()` 写入
Span Status。sanitizer 输出稳定低基数 `error.type` 与最多 1024 字节的脱敏摘要；移除
Authorization、Cookie、API Key、BYOK、管理员 token、密码、渠道配置密钥和上游响应体。

需要关联 secret 时使用 HMAC-SHA256：输入为 `purpose + 0x00 + secret`，密钥来自
`LLMGATEWAY_OTEL_HASH_KEY`，输出前 12 字节的 24 位小写 hex，并记录
`llmgateway.hash_key.id`。密钥缺失时省略 correlation hash，不能退化为裸 SHA 或明文。
轮换后新记录使用新 key ID，允许跨轮换 hash 不可关联；内部 user ID、实体 ID 和已非密钥
的 external key ID 不做 HMAC。

### stderr 防线

每个可执行程序在解析配置、连接依赖或输出第一条日志之前，把标准库全局 logger 和项目
logger 的输出替换为共享 `SanitizingWriter(os.Stderr)`。它注册当前进程已加载的数据库、
Redis、管理员和遥测 hash secret，并额外清理 Bearer/Cookie、URL userinfo/query、常见
`sk-*` token 及 password/key/token 字段。`log.Fatal*` 也必须经过该 writer；新增代码禁止
直接向 `os.Stderr` 写可能包含错误或配置的文本。

stderr writer 是防御性末线，不替代 typed safe error。业务日志不得主动格式化上游响应
正文或 secret-bearing 对象。测试覆盖启动失败、worker raw error、fatal 路径和已知/模式
secret，保证 stdout 与 stderr 均不出现测试密钥。

## 状态事件提交语义

状态事件只能由拥有该事实写入权的 mutator 发出。mutator 在同一事务、锁或 CAS 中取得
from 状态并完成写入，提交成功后返回包含 from/to、实体、time 和 writer 的
`Transition`。调用层随后把 Transition 入遥测队列：

- 提交失败不发 state_changed；
- from 等于 to 的 no-op 写不发 state_changed，可在当前 Span 标记 outcome=noop；
- 并发 CAS 失败标记 conflict，不伪造状态变化；
- 状态提交成功但进程在入队前崩溃时允许丢事件，事实表仍可恢复当前状态；
- 有原生 monotonic version 的实体同时记录 version；没有版本的实体不生成虚假版本；
- 遥测允许重复。CLS 不把状态事件作为有序真源，也不依赖事件去重恢复状态；发生歧义时
  按实体 ID 回查事实表。`transition.time` 仅用于检索和展示，不作为并发排序依据。

预期的 lease 竞争只增加低基数聚合指标，不逐次写 WARN。lease 过期、被接管或持续竞争
超过阈值才输出事件。drift 只在状态发生变化时输出，并可每 6 小时输出一次受限 reminder。

## Set 生命周期

### Span

- `llmgateway.set.reconcile`；
- `llmgateway.set.provision`；
- `llmgateway.set.admission_check`；
- `llmgateway.set.upgrade`；
- `llmgateway.set.runtime_switch`；
- `llmgateway.set.runtime_drain`；
- `llmgateway.set.rollback`；
- `llmgateway.set.decommission`；
- `llmgateway.set.purge_tenants`；
- `llmgateway.set.runtime_cleanup`；
- `llmgateway.set.decommission_finalize`。

公共必填字段只有 operation、outcome；Set ID 在已知时必填。各 Span 字段矩阵：

- `set.provision`：Set、Shard、provision request ID、attempt 必填，generation 可选；
- `set.reconcile`：Set 和 reconcile source 必填，Shard/request/generation/attempt 可选；
- `set.admission_check`：Set 必填，Shard/check attempt 可选；
- `set.upgrade`、runtime switch/drain/rollback：Set、upgrade run ID、from/to generation 和
  attempt 必填；
- `set.decommission`/purge/finalize：Set、decommission job ID 和 attempt 必填，Shard 可选；
- `set.runtime_cleanup`：Set、cleanup/decommission job ID、attempt 和 Shard 必填；
- manual Set 不要求 Shard 或 provision request ID。

缺失字段直接省略，禁止用空 UUID、0 generation 或临时随机值伪造。调用 Kubernetes、
control API 或 new-api 时创建子 Span；set-manager HTTP 请求注入 W3C
Trace Context。下一次 CronJob/reconcile attempt 创建新 Trace，通过 request/run ID 关联。

### 权威状态事件

以下 committed transition 输出 `llmgateway.set.state_changed`：

- provision request；
- Set reconcile fact；
- Set admission；
- runtime generation；
- upgrade run stage；
- runtime route switch、drain、retire、rollback；
- Set decommission job：start、purging_tenants、pending、removing_runtime、
  cleanup_ack_pending、error、cancelled、succeeded；
- runtime/operation lease 过期或接管。

失败 attempt 输出 `llmgateway.set.operation_failed`。事件包含实体类型/ID、from/to、
generation、attempt、writer 和脱敏错误。

### Set 下线和 runtime cleanup

Set decommission 使用现有 `SetDecommissionJob` 作为 durable 关联事实。start、tenant purge、
claim、runtime cleanup、failure、retry、cancel、finalize、acknowledge 及所有 terminal state
都必须在事实提交成功后输出 committed transition。maintenance worker、set-manager 和
runtime-cleaner 每次 attempt 创建独立 root Trace，通过 decommission job ID、Set ID 和
attempt 关联；立即发生的 HTTP 请求仍注入 W3C Trace Context。

`cleaning_runtime` 和 `finalizing` 在当前实现中只作为执行 Span phase 观测，不作为
committed `SetDecommissionJob` transition。除非未来先增加对应持久化 mutator、CAS、恢复
语义和测试，否则不得输出这两个 state_changed 事件。

runtime-cleaner 在删除 Set 数据库和 Redis DB 前后创建 `llmgateway.set.runtime_cleanup`
Span，只记录 cleanup ID、Set、Shard、database name、Redis DB 编号、attempt 和 outcome。
claim token、cleanup capability、lease fingerprint、MySQL/Redis 密码和控制面内部 token
全部视为 secret，不得进入 Span、Log、Status、exception 或 stderr；发生鉴权失败只记录
稳定 `error.type`。

cancelled 和 succeeded 是 job terminal；error 是一次 attempt 的失败状态，可以通过
`RetrySetDecommission` 回到 pending 或 purging_tenants。cleanup_ack_pending 只有
set-manager 完成 Kubernetes cleanup 清理后才能 acknowledge。失败重试增加 attempt 并产生
新 Trace，不能复用旧 Span。runtime-cleaner Job 自身必须初始化 stdout pipeline、安装
stderr sanitizer，并在退出前 bounded flush。

admission gate 使用固定枚举：

- `runtime_managed`：有 provision request 时必须为 managed；无 request 的手工 Set 跳过此
  gate，但仍必须执行并通过后续全部 admission gates；
- `set_active`；
- `bootstrap_local`：本地 setup/admin 凭据存在；
- `bootstrap_remote`：new-api setup 完成；
- `set_plan_ready`：全部 active Plan 在 Set 上 ready；
- `channel_bundle_applied`：存在安全的已应用 fingerprint；
- `pricing_complete`：已应用 revision 定价完整。

compliance 是 bootstrap 内部步骤，不是最终 admission gate。AutoGroups 是 ChannelBundle
option，不是独立 gate。GroupRatio 有 pre-admission 写入例外，不作为最终 admission gate，
否则会造成 bootstrap 死锁。已 passed Set 在 recheck 运行期间继续保持 passed；只有完整检查
结果提交后才改变稳定决定。

现有 `setReadyForServing` 对空 admission 且无容量配置的 legacy fallback 必须移除。部署迁移
先把空 admission 回填为 pending 并触发 admission check；回填完成后，新用户选择、租户
写入、subscription、BYOK 和 observation 全部使用同一 readiness predicate：active、setup、
admin health 非 unhealthy、admin writes 未暂停且 admission=passed。唯一例外仍是
`group_ratio_write` 的 bootstrap 通道。迁移期间空 admission 一律不承载新操作。

## 租户准入和权益

### Span

- `llmgateway.tenant.admit`；
- `llmgateway.tenant.select_set`；
- `llmgateway.tenant.ensure_binding`；
- `llmgateway.tenant.ensure_upstream_user`；
- `llmgateway.key.issue`、`llmgateway.key.revoke`；
- `llmgateway.subscription.apply`、`.cancel`、`.extend`；
- `llmgateway.plan.sync`；
- `llmgateway.route_snapshot.publish`；
- `llmgateway.admin_command.execute`。

父 Span 必须包含内部 user ID。Set 选择记录候选数量、选中 Set/Shard、水位和 blocked
原因，不记录候选列表。订阅记录 Plan、Set、上游 Plan、幂等 outcome 和最终权益状态；
idempotency key 只允许写 HMAC correlation hash。

### 准入结果映射

准入 outcome 由真实状态组合产生，不新增虚拟“tenant admitted”状态：

- tenant 必须 active，backend 为 pending 或 new；
- 已绑定租户复用其 Set，新租户才执行容量选择；
- 目标 Set 必须 active、admission passed、admin health 非 unhealthy；
- 同步管理写遇到 `admin_writes_paused` 时进入 durable admin command，而不是失败；
- 新分配要求容量选择器 accepting；短时轻微超卖仍是允许语义；
- binding 依次为 allocated、user_ready、token_ready 或 failed；
- 发放订阅要求 active Plan 及目标 Set 的 ready SetPlan。

拒绝/blocked 事件必须记录上述稳定原因枚举，不只记录自由文本。

### 权威状态事件

- `llmgateway.tenant.state_changed`：tenant/backend、binding provision transition；
- `llmgateway.key.changed`：Key 签发/撤销，含 user ID、Set ID、external key ID；
- `llmgateway.entitlement.changed`：Plan 同步及 subscription apply/cancel/extend；
- `llmgateway.subscription_idempotency.state_changed`：不存在/failed → processing，及
  processing → succeeded|failed|unknown；
- `llmgateway.admin_command.state_changed`：pending → running → succeeded|unknown，及释放回
  pending/error；
- `llmgateway.tenant.operation_failed`：上游用户、Key、Plan、订阅或 route snapshot 操作失败。

admin command 覆盖 apply/cancel/extend subscription 和 queued key creation。事件记录 command
ID、kind、user ID、Set ID、attempt、dedupe outcome；dedupe 冲突使用 outcome=conflict，不能
记录 payload 或完整 dedupe/idempotency key。异步 worker 新建 root Trace，以 command ID 关联
入队请求，不承诺继承原 HTTP Trace。

subscription idempotency 事件只在 `TryBeginSubscriptionIdempotency` 或
`FinishSubscriptionIdempotency` 提交成功后发出，记录 user ID、Plan ID、状态、outcome 和
`llmgateway.subscription.idempotency_hash`。该 hash 使用本文 HMAC 规则；request hash 可作为
不可逆 correlation value，但不能记录原始 idempotency key。failed 重试重新进入 processing；
无法确认上游成功且本地完成失败时进入 unknown，并以 ERROR 输出。测试覆盖首次获取、相同
请求命中 succeeded、不同 request hash conflict、failed retry 和 indeterminate commit。

## 配置一致性

### Span

- `llmgateway.config.release`；
- `llmgateway.config.apply_set`；
- `llmgateway.config.check_drift`；
- `llmgateway.config.rollback`；
- `llmgateway.group_ratio.sync`；
- `llmgateway.byok.sync`。

release 父 Span 包含 bundle、revision、run ID、目标 Set 数量和 stop_on_failure；每个目标
Set 创建子 Span。drift 检查按 Set 建 Span，不按渠道建 Span。AutoGroups 仅作为 bundle
option 的 apply step 观测，不创建独立 Span 或 desired/applied version。

### 实体字段矩阵

- ChannelBundle revision：`bundle.id`、`revision.id`、`revision.version`、
  `revision.fingerprint`；
- release run/item：`release.run.id`、Set ID、item status、stop_on_failure；
- bundle sync state：Set ID、desired/applied/actual fingerprint、status；
- GroupRatio：Set ID、desired/applied version、desired/applied fingerprint、status；
- BYOK task：内部 user ID、Set ID、requested/processing/applied version、attempt、status。

字段使用完整前缀，例如 `llmgateway.channel_bundle.revision.id`、
`llmgateway.group_ratio.desired_version` 和 `llmgateway.byok.requested_version`，不使用含义
不明的通用 `revision`/`fingerprint`。

### 权威状态事件

- `llmgateway.config.state_changed`：release run/item、bundle sync state、GroupRatio apply state、
  BYOK task committed transition；
- `llmgateway.config.drift_detected`：从非 drift 进入 drift，或受限 reminder；
- `llmgateway.config.operation_failed`：apply/check/rollback/sync attempt 失败。

revision 创建和 rollback 创建新 revision 是 committed entity event。provider key、BYOK key、
DesiredConfig 明文密钥和远端响应正文永不进入遥测；fingerprint 只使用现有不可逆摘要。

## 严重级别、采样和指标基数

- 正常 committed transition：INFO；
- retry、blocked、drift 或 lease takeover：WARN；
- 本次 attempt 失败或最终 error/unknown：ERROR；
- FATAL 只用于进程即将退出；
- control/worker/set-manager 使用 AlwaysOn，忽略远端未采样决定但保留有效 trace ID；
- Logs/Traces 可以包含 Set、Shard、Plan、run、task 和 user ID；
- Metrics label 只允许 service、operation、outcome、status、error.type、Set/Shard 和固定 job
  kind；禁止 user ID、Key ID、run/task ID、fingerprint 和 lease owner；
- 现有 upgrade metrics 移除 run_id label，worker metrics 不暴露 lease owner；
- lease contention 使用按 operation/outcome 聚合的 counter；
- 遥测失败不能改变业务结果。

## 测试

### Pipeline 单元测试

- 注入 writer/clock，生成 Trace/Log canonical golden JSONL，并验证 LogRecord.eventName；
- 每行可按对应 OTLP protobuf JSON 反序列化，且只含一个记录；
- 验证 lowerCamel、数字 enum、十进制字符串 int64、hex ID；
- 并发 Trace/Log 写入不交错，记录不超过 32 KiB；
- 活动 Span 的 Log 关联相同 ID，无 Span 时不生成 ID；
- queue full、编码失败、超限和 blocked writer 不阻塞业务，并累计/报告 drop；
- shutdown 在 5 秒内 flush 或超时退出；
- sanitizer 覆盖 attributes、Status、exception、Log body/eventName 和 legacy stderr；在
  stderr logger 初始化前不得输出任何日志，测试 startup/fatal/worker secret 不能出现。

### 状态机测试

- commit 成功后发 transition；commit 失败、CAS conflict 和 no-op 不发假 transition；
- Set provision/admission/upgrade/switch/rollback 的成功、失败、重试；
- Set decommission start/purge/claim/cleanup/fail/retry/cancel/finalize/ack/terminal；
- passed admission recheck 保持稳定，manual Set 跳过 runtime_managed gate 和 GroupRatio
  bootstrap 例外；
- Set 选择、binding、用户创建、Key 签发/撤销、Plan 和 subscription apply/cancel/extend；
- admin command 入队、dedupe conflict、pending/running/succeeded/unknown；
- channel release、drift、rollback、bundle option、GroupRatio 和 BYOK version；
- 跨 durable boundary 使用新 Trace，并通过 request/run/task/command ID 关联；
- lease 正常竞争不产生日志洪峰，drift reminder 受频率限制。

### 部署和 CLS 测试

- manifest 断言 control、core/admin/byok/observer/maintenance worker、set-manager 和动态
  runtime-cleaner Job 的 service name、开关、版本、资源属性和 pipeline 参数；traffic 不启用；
- set-manager 和 runtime-cleaner 正常 flush；
- CLS 使用固定 JSON 路径检索 trace ID、service、event、severity；
- 使用 event name 加整行精确词检索内部 user ID、Set ID、run/task ID；
- 人工制造 admission 失败、subscription idempotency conflict 和 channel drift，验证三条链路；
- 验证 decommission start → purge → claim → runtime cleanup → finalize → ack → succeeded，
  以及 failure/retry/cancel；
- 捕获 cleanup 全部输出，确认 claim token、cleanup capability、lease fingerprint 和数据库/
  Redis secret 不存在；
- 验证 stdout 只包含 OTLP payload JSONL，普通文本只在 stderr。

## 完成标准

值班人员依赖 CLS 与事实表即可回答：

1. 一个 Set 卡在哪个阶段，最近 attempt、gate 和失败原因是什么；
2. 一个内部 user ID 被分配到哪个 Set，binding、Key、Plan、订阅或 deferred command 到哪一步；
3. 一个配置 revision 在哪些 Set applied、failed 或 drift；
4. 同一同步操作可通过 trace ID 串联，跨异步边界可通过 durable ID 串联；
5. stdout payload 可被标准 OTLP protobuf JSON 解码，且不存在密钥和模型正文。
