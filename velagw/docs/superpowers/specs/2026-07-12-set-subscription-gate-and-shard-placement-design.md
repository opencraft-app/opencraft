# Set 订阅闸门与 Shard 放置设计

## 背景

北京生产压测确认 new-api 的订阅写入存在连接池自锁条件：每个 Pod 的
`SQL_MAX_OPEN_CONNS=5`，订阅事务占用一个连接后，事务内部的
`GetDBTimestamp()` 又通过全局 DB 申请连接。单 Pod 同时进入 5 个订阅事务时，
5 个事务会共同等待第 6 个连接并永久卡住。

同时，现有自动扩 Set 逻辑只根据 open request 下标轮转 Shard。每轮只创建一个
Set 且没有 open request 时会一直选择第一个 Shard，已造成 shard-a 与 shard-b
的 Set 数量明显失衡。

本设计不修改 new-api，通过 LLMGateway 控制面增加外部保护，并修正 Shard 放置。

## 目标

- 跨多个 control 副本限制同一 Set 的订阅写入并发，避免触发 new-api 自锁。
- 使用显式 Set 容量单位选择 Shard，不根据数据库连接池上限猜测负载。
- Set 数据库路径异常后及时停止新用户分配。
- 云上回归使用最多 60 个并发用户，不修改生产保护参数。

## 非目标

- 不修改 new-api 源码或数据库表。
- 不自动迁移已有 Set。
- 不根据瞬时 CPU、连接数或用户活跃度动态搬迁 Set。
- 本期不实现自动重启 new-api Pod；先完成隔离、停止准入和人工恢复闭环。

## 1. Fleet/Shard 数据库连接池策略

连接池参数不能写死在 RGD 模板，也不能由每个 Set 单独维护。配置真源采用两级继承：

1. Fleet 提供所有 Shard 的默认值；
2. Shard 可根据其 MySQL 规格覆盖默认值；
3. Set 只保存最终生效值作为运行时投影，不允许成为配置真源。

配置按 new-api 角色拆分，避免管理请求与流量请求使用同一个经验值：

```yaml
spec:
  newapi:
    databasePool:
      admin:
        maxOpenConns: 32
        maxIdleConns: 2
        maxLifetimeSeconds: 60
      traffic:
        maxOpenConns: 32
        maxIdleConns: 2
        maxLifetimeSeconds: 60
    subscriptionWriteConcurrency: 8
  shards:
    - name: shard-a
      maxSets: 32
      databasePool: {} # 未配置字段继承 Fleet 默认值
    - name: shard-b
      maxSets: 16
      databasePool:
        admin:
          maxOpenConns: 24
```

字段按叶子节点覆盖。例如 shard-b 仅覆盖 admin 的 `maxOpenConns`，其他字段仍继承
Fleet。`SQL_MAX_OPEN_CONNS` 是连接上限而非预创建连接数，空闲连接仍由
`maxIdleConns` 控制。

校验规则：

- `maxOpenConns > 0`；
- `0 <= maxIdleConns <= maxOpenConns`；
- `maxLifetimeSeconds > 0`；
- `subscriptionWriteConcurrency > 0`；
- 默认要求 `subscriptionWriteConcurrency * 2 <= admin.maxOpenConns`，为事务内部的
  第二连接及其他管理请求保留余量。

Shard 覆盖值变化后由 Fleet reconciler 滚动更新归属该 Shard 的 new-api Pod。既有 Set
表中的 `sql_max_open_conns` 和 `sql_max_idle_conns` 仅记录最终生效值，供管理台和排障
查看。

## 2. 每 Set 订阅并发闸门

LLMGateway MySQL 新增独立的 Set 操作租约表。Fleet 管理的 Set 默认预置 8 个逻辑 slot；
尚未物化 Fleet 配置的旧 Set 安全回退为 4，
control 在调用 new-api `AdminCreateUserSubscription` 前竞争一个 slot，调用完成后
立即释放。

租约包含：

- `set_id`
- `operation`，一期固定为 `subscription_write`
- `slot`，取值由最终生效的 `subscriptionWriteConcurrency` 决定
- `owner`
- `lease_expires_at`
- `updated_at`

获取规则：

1. 在 MySQL 事务中选择空闲或已过期 slot。
2. 使用条件更新写入 owner 和过期时间，确保两个 control 副本不能同时获得同一 slot。
3. 没有 slot 时短轮询等待，等待过程遵循请求 context；调用方取消后立即停止。
4. new-api 调用结束后按 `set_id + operation + slot + owner` fenced release。
5. 租约 TTL 默认 30 秒；实际调用超过 TTL 时定期续租。旧 owner 不得释放新 owner 的租约。

并发上限是正确性边界，不是压测参数。生产初值为 8，并与该 Set 所属 Shard 最终生效
的 admin 连接池配置联动校验。即使所有请求被 Kubernetes Service 路由到同一个
new-api Pod，也会为事务内部查询及其他管理请求保留连接余量。

## 3. Shard 容量单位

Shard 新增 `max_sets`：该 Shard 允许承载的 Set 容量单位总数。普通 Set 一期固定
占用 1 个单位。

放置时统计：

- 已纳管 Set；
- 非终态 provision request；
- 已分配但尚未完成纳管的 runtime lease。

同一个 `set_id` 只能计数一次。Shard 分配率定义为：

```text
allocated_units / max_sets
```

候选 Shard 必须同时满足：

- 状态为 active；
- Redis DB 区间仍有可用编号；
- `allocated_units + 1 <= max_sets`；
- 没有被健康状态标记为不可分配。

选择顺序：

1. 分配率最低；
2. 已分配容量单位更少；
3. Shard ID 字典序，保证结果确定。

若 `max_sets` 未配置或为 0，兼容模式下按绝对 Set 数最少选择，但生产模板必须显式
配置。数据库连接率、CPU 和内存只作为暂停分配的保护信号，不进入主排序公式。

## 4. DB-aware Set 健康

新增 worker job `check_set_admin_health`，使用已保存的 new-api 管理 access token 调用
会经过鉴权和数据库查询的轻量接口，并设置短超时。任务按持久 cursor 分批处理，不能
阻塞其他 worker job。

状态机：

- 成功：记录 `last_admin_health_at`，连续成功后恢复健康状态；
- 失败：记录错误和连续失败次数；
- 连续两次失败：Set 退出新用户准入，但不影响已有 traffic route；
- 人工重启并重新 bootstrap 后可立即触发检查恢复。

容量选择器只选择 active、setup、admission passed 且 admin health healthy 的 Set。
本期不由 worker 直接操作 Kubernetes 重启 Pod。

## 5. 回归测试

### 单元和 MySQL 集成测试

- 两个 owner 最多同时获得配置数量的 slot；下一个请求必须等待。
- Fleet 默认连接池、Shard 叶子覆盖和 Set 最终投影计算正确。
- 不合法的连接池与订阅并发组合在调和前被拒绝。
- lease 续租、过期接管和 fenced release。
- context 取消后等待者退出，不遗留 slot。
- Shard 放置统计 Set、request、lease 后选择最低分配率。
- `max_sets` 满载、disabled Shard、Redis DB 耗尽时被排除。
- 健康连续失败后退出准入，恢复成功后重新准入。

### 北京生产回归

- 总并发上限 60，不再使用 200 瞬时并发。
- 定向同一 Set 验证订阅写入不会超过最终生效的并发上限。
- 60 并发下所有请求在超时内完成，结束后 new-api 登录、bootstrap 和 worker drift
  检查仍可正常返回。
- 创建多个 provision request，验证新 Set 优先进入分配率更低的 Shard。
- 回归期间保持 new-api 资源保护、模型限流和生产参数不变。

## 发布顺序

1. 迁移 LLMGateway MySQL 租约表和 Shard `max_sets`、连接池覆盖字段。
2. 发布 control/worker，暂不启用自动扩容写入。
3. 为 Fleet 配置连接池默认值，并为两个生产 Shard 配置明确的 `max_sets` 和必要覆盖。
4. 启用订阅闸门和 DB-aware 健康任务。
5. 运行 60 并发定向回归。
6. 恢复自动扩 Set，并验证 Shard 放置结果。
