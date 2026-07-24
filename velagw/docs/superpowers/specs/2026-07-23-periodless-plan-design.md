# Periodless Plan 与外部有效期设计

## 背景

VelaGW 当前同时建模业务套餐有效期与 new-api 订阅额度：

- `Plan.period_value/period_unit` 定义默认有效期。
- `PlanPeriod`、`SetPlanPeriod` 为同一 Plan 创建 14 天、30 天等周期变体。
- ctl 在创建 Pass 时把实际购买时长传给 `ApplySubscription`。
- ctl 在续费、退款和回滚时调用 `ExtendSubscription` 对齐 `period_end`。

new-api 的用户订阅结束时间在创建时由 Plan duration 生成，当前管理 API
不能修改已有订阅的 `end_time`。VelaGW 的 `period_end` overlay 因而只改变
本地投影，不能改变 new-api 的真实过期时间。

另一方面，new-api 原生支持独立的额度重置策略：`daily`、`weekly`、
`monthly`、`custom` 和 `never`。后台 master 每分钟重置到期额度，扣费热
路径也会惰性执行重置。

## 设计决策

### 职责边界

- trade/ctl 是业务有效期真源，负责 Pass 到期、续费、隔离和恢复。
- VelaGW 负责确保用户在归属 Set 中拥有目标 Plan 的一份长期订阅。
- new-api 负责周期额度、周期重置和请求扣费。
- 不修改 new-api，不直接修改 new-api 数据库。

### Plan 模型

业务 Plan 使用稳定 ID，包含：

- `id`
- `name`
- `monthly_tokens`
- `quota_reset_period`
- `quota_reset_custom_seconds`
- `is_active`

Plan 不包含订阅有效期。修改额度或重置策略必须创建新的业务 Plan ID；
`id`、`name`、额度和重置策略一经创建即不可变。
`is_active` 是独立的生命周期状态，只允许从 `true` 转为 `false`；该动作
不可逆，不改变权益内容，也不触发 new-api Plan 重建。管理端不提供原地编辑，
只提供“基于此创建新版”和“停止新发放”。

当前 API 和数据库中的 `monthly_tokens` 暂时保留为兼容字段和存储列，语义
改为每周期额度，并且是唯一额度输入和存储真源。管理界面使用“周期额度”，
不再使用“月度额度”，不新增 `quota_amount` 双写字段。

### new-api 映射

每个 `(plan_id, set_id)` 只维护一条当前映射。new-api Plan 使用固定长期
duration：

```text
duration_unit = year
duration_value = 100
quota_reset_period = Plan.quota_reset_period
quota_reset_custom_seconds = Plan.quota_reset_custom_seconds
total_amount = Plan.monthly_tokens
```

managed marker 使用
`llmgateway plan:v3:<sha256(plan_id)>:<full-fingerprint>`，长度固定且不受
合法 Plan ID 长度影响。同一个业务 Plan 在每个 Set 只初始化一次；权益变化
使用新的业务 Plan ID，因此不存在同一 Plan 的 revision 替换。

不在运行时代码中清空、删除或重建旧 SetPlan 数据。旧 PlanPeriod 和
SetPlanPeriod 行可以保留，但新代码不再读取或写入它们；ctl 的旧
`ai_gateway_plans` JSON 同样只保留为脏数据，不参与选择。新的空集群只产生
v3 映射。

`SetPlan.applied_fingerprint` 表示远端已经确认创建了该不可变 Plan。创建
pending SetPlan 时不得自动填充该字段。首次同步没有 applied fingerprint 的
Set 处于 `pending/syncing/error` 且不得使用该 Plan 发放权益；成功后状态进入
`ready`。重复同步只用于修复首次下发失败或确认远端资源，不创建新 revision，
也不隐藏已经 ready 的稳定映射。

首次同步按 `(plan_id,set_id)` 获取独占 lease。每次写远端前先按完整 marker
探测：已存在则领养，不存在才创建；创建响应丢失时保持非 ready，重试重新探测
并领养。领养和后续确认都必须验证 marker 唯一，并核对 100 年 duration、
`monthly_tokens -> total_amount`、reset policy 和 custom seconds；重复 marker
或字段不符进入 error，不得创建或替换。ready 映射的
`upstream_plan_id/applied_fingerprint` 是终态，后续同步只能确认，不能替换。

已曾 ready 的映射如果远端缺失、出现重复 marker 或权益字段漂移，保留原映射
ID/fingerprint，但将状态改为 error，排除该 Set 的新发放并告警；不得自动重建。
人工恢复必须创建新的业务 Plan ID。已有订阅是否仍能扣费由 new-api 远端实际
状态决定，不由 VelaGW 伪造成功。

legacy SetPlan 是唯一例外：`applied_fingerprint` 为空或远端 marker 不是 v3
时，不领养旧 14/30 天 Plan，而是在无存量用户的前提下创建 v3 长期 Plan，
验证成功后覆盖同一 SetPlan 映射。旧远端 Plan 和周期表保留为脏数据，不删除。
`applied_fingerprint` 非空且 marker 为 v3 的 ready 映射按新终态处理。该
一次性兼容路径不扫描用户，不适用于有存量订阅的环境。

创建新版 Plan 后，先同步到目标 Set 并确认 ready，再把 ctl Bundle 引用切换到
新的 Plan ID。旧 Plan 停止新发放后，已有长期订阅继续使用旧权益；不扫描、不
批量改写已有用户订阅。

ctl Bundle 的标量列 `ai_gateway_plan_id` 是当前引用真源；旧
`ai_gateway_plans` JSON 不读取、不写入。Bundle 切换前必须校验新 Plan
`is_active=true`、额度一致且所有 active Set 已 ready。切换是 ctl Bundle 单行
更新；失败时继续引用旧 Plan。顺序固定为：

```text
创建新 Plan -> 全 Set ready -> 切换 Bundle.ai_gateway_plan_id -> 停止旧 Plan
```

### 用户订阅语义

现有 `ApplySubscription` HTTP 地址保留，内部语义改为
`EnsureSubscription`：

- 普通套餐调用必须传 `is_unique=true`。用户没有 active subscription 时创建
  一份长期订阅；已有同一业务 Plan 时直接复用；存在其它普通套餐或重复
  subscription 时创建/保留目标 Plan，并收敛为单个普通套餐 subscription。
  `free-credit:` 命名的赠送权益不参与该收敛，不会因套餐切换而被撤销。
- 赠送积分、迁移补偿等可叠加权益使用 `is_unique=false`，每个新的幂等命令创建
  一份独立长期 subscription，不失效用户已有套餐或其它赠送权益。缺省值为
  `false`，保持旧调用方的叠加语义。
- `subscription_name` 和 `is_unique` 参与幂等请求哈希；业务周期字段不参与。
- 同一请求重复执行：依赖现有 idempotency key 保证结果一致。
- 有效期内续费：ctl 只更新 Pass，有效订阅继续由 new-api 周期重置。
- 到期后续费：旧订阅已取消，ctl 再调用 Apply/Ensure 创建新订阅。

`is_active=false` 后，只允许查询或返回已经存在的同 Plan active
subscription；如果目标订阅不存在，Apply/Ensure 必须返回 PlanNotFound，不得
创建，也不得取消用户当前的其它订阅。Apply 在真正创建前、持有用户级 lease
期间重新读取 `is_active`，该次读取是停止发放与并发 Ensure 的线性化点：读取
发生在停止提交前的请求可以完成，读取发生在停止提交后的请求必须拒绝。

订阅切换始终先创建并重新查询确认目标订阅，再失效其它 active subscription。
部分失效失败时返回错误；下一次 Ensure 保留已确认的目标订阅并继续收敛，绝不
先撤销旧权益再尝试创建目标权益。

兼容发布期间继续接受 `period_value/period_unit`，但不参与目标 Plan 选择、
幂等哈希或响应投影。`ExtendSubscription` 暂时保留为幂等 no-op，待 ctl
完全停止调用后再删除。

不同 idempotency key 仍可能同时操作同一用户，因此 Apply/Cancel 额外使用
用户级分布式 lease 串行化；Set 级写闸门继续限制 new-api 订阅写并发。两者职责
不同，不能只依赖 idempotency 表。

### ctl 生命周期

- 新购/试用：调用 Apply/Ensure。
- active Pass 续费：不调用 VelaGW，只更新 `pass.expired_time`。
- isolated Pass 续费：在恢复服务前调用 Apply/Ensure。
- Pass 到期隔离：完成实例隔离后、写入 isolated 终态前，必须可靠调用
  `CancelSubscription`。
- 销毁：重复调用取消接口是幂等清理。

当前销毁中的取消步骤是 best-effort。新设计把取消变成父任务的必需步骤：
失败保持任务非终态并按既有任务机制重试。当前业务约束仍是一名用户仅有
一个在用 Pass，因此取消语义是按用户撤销全部 active subscription。

新购在 VelaGW Ensure 成功、ctl 本地事务失败时同步调用 Cancel 补偿，并同时
保留本地错误和补偿错误。跨进程崩溃窗口仍依赖上层订单回调按同一
idempotency key 重放；若未来试用入口要求严格的崩溃恢复，需要另行增加 durable
provision intent，而不能假装 HTTP 调用与 MySQL 事务原子。

API Key 和用户绑定不随订阅取消而删除。用户续费恢复后继续使用原 Key。

## 数据与兼容

当前 new-api 集群没有需要迁移的存量用户，因此不实现用户订阅迁移、双写
或批量回填引擎。

数据库迁移采用非破坏方式：

- 保留 Plan 的旧 period 列和周期变体表。
- 新服务代码停止读取和写入周期字段/周期表。
- 新 Plan fingerprint 只包含 ID、名称、周期额度和重置策略，不包含
  `is_active`。旧 fingerprint 不在启动时重写；legacy 映射按上面的 v3 规则
  一次性重新物化。
- 对旧 fingerprint 采用兼容读取，不执行启动时全表清理。
- legacy SetPlan 的 `applied_fingerprint` 为空时必须重新探测/下发，不能根据
  当前 desired Plan 在本地补写指纹。

旧 API 调用在一个发布窗口内兼容，随后从 OpenAPI、管理界面和 ctl 类型中
移除周期字段。

## 错误处理

- Ensure 查询 new-api 失败时不创建第二份订阅，任务重试。
- Ensure 创建响应丢失时先重新读取远端；已按同一 `request_id` 落库则直接领养，
  未可见时才沿用现有 idempotency `unknown` 状态，禁止用新的请求 ID 盲目重放。
- 取消失败时 Pass 隔离任务不得成功结束。
- new-api 重置任务延迟不影响正确性，扣费路径会惰性重置。
- Plan 未同步到用户归属 Set 时，Ensure 返回明确错误，不回退到周期变体。

## 测试

### VelaGW

- Plan 创建不需要 period。
- 同一 Plan ID 使用不同权益内容重复创建返回 immutable conflict。
- PUT 原地编辑返回 method not allowed；权益变化通过 POST 创建新 Plan。
- `POST /api/plans/{id}/retire` 幂等停止新发放；不能重新启用，fingerprint 和
  SetPlan 均不改变。
- 同一 Plan 在 Set 中创建 100 年、指定 reset policy 的 upstream Plan。
- 14 天和 30 天兼容请求命中同一个 SetPlan。
- `is_unique=true` 且已有同 Plan active subscription 时 Ensure 不创建第二份。
- `is_unique=false` 创建叠加权益且不失效已有套餐。
- 已取消或过期时 Ensure 创建新订阅。
- Set admission 不再依赖 PlanPeriod。
- pending SetPlan 不会伪装成 applied；重复同步不会隐藏已有 ready 映射。
- 创建响应丢失后重试按完整 marker 领养，不创建重复 Plan。
- 两个 worker 同步同一 `(plan_id,set_id)` 时只有 lease 持有者写远端。
- legacy 14/30 天映射不被 v3 领养，验证新长期 Plan 后才替换本地映射。
- 停止发放后已有订阅继续可用；没有目标订阅的 Ensure 被拒绝且不影响其它订阅。
- 停止发放与 Ensure 并发时以用户 lease 内的二次状态读取为边界。
- Extend compatibility no-op 不写 overlay。
- 旧周期表存在不影响 v3 Plan 同步。

### ctl

- Bundle 导入只校验额度，不校验 Plan 周期。
- Bundle 引用切换校验 Plan 可发放、额度一致和 active Set readiness。
- 新购仍调用 Apply/Ensure。
- active 续费不调用 Apply 或 Extend。
- isolated 续费调用 Apply/Ensure 后才能恢复 active。
- isolate/destroy 取消失败会重试且不进入终态。
- isolated 续费失败回滚会先重新隔离实例，再取消长期权益，最后恢复 isolated。
- 相同续费任务重放不会创建重复订阅。

### E2E

- 创建 monthly Plan 和用户，连续扣费后验证余额下降。
- 通过可控 custom reset 验证同一订阅额度恢复且订阅 ID 不变。
- ctl 延长 Pass 时 new-api 订阅数量不增加。
- Pass 隔离后原 API Key 因无 active subscription 无法扣费。
- 续费恢复后原 API Key 可继续调用。
