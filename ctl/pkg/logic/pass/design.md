# Pass 用户权益 — 需求设计文档

> 日期：2026-04-17（2026-04-19 更新：credit 换算 + 订阅联动 + 周期统一）  
> 状态：已实现（基础能力）+ 设计中（credit/订阅联动/周期统一）  
> 归属服务：CTL (控制面) + admin-gateway (后台管理代理) + ai-gateway (Token 订阅)  
> 前置依赖：[Bundle 权益套餐包](bundle-design.md)

---

## 1. 需求背景

Bundle 设计解决了"套餐定义"的问题，但尚未建立用户与套餐之间的绑定关系。当用户购买（或被赠送）一个 Bundle 后，系统需要一个实体来承载：

- **谁** 拥有了哪个套餐的权益
- **什么时候** 生效、什么时候到期
- 后续可据此联动配额系统（`user_resource_quota`），实现从"购买套餐"到"生效权益"的完整闭环

**Pass（用户权益）** 就是这个承载实体——代表"某用户持有某 Bundle 的一份权益实例"。

---

## 2. 核心概念

### 2.1 Pass（用户权益）

Pass 是 Bundle 与用户之间的绑定记录，表示"用户持有一份套餐权益"。

- 每个 Pass 通过 `pass_id` 唯一标识
- 通过 `bundle_id` 关联到 Bundle（套餐模板）
- 通过 `user_id` 关联到用户
- 冗余存储 `uin`（腾讯云用户账号）和 `app_id`（腾讯云应用 ID），数据来源于 shadow 服务的 `Binding` 表，避免计费场景下高频跨服务调用
- `expired_time` 标识权益到期时间。**有效期由 Bundle 的 `time_span` + `time_unit` 决定，不由用户指定**
- `isolated_time` 预留字段，标识权益被隔离的时间（当前阶段不使用，留待后续隔离能力扩展）
- `deleted_time` 预留字段，标识权益被销毁的时间（当前阶段不使用，留待后续销毁能力扩展）
- 一个用户同一时间仅持有一个 Pass（在 `CreateTrialPass` 中做业务校验，不在 DB 层做唯一约束）
- 一个 Bundle 可以被多个用户购买，产生多条 Pass

### 2.1.1 Pass 有效期模型：由 Bundle 的 time_span/time_unit 决定

**Pass 不再接受用户指定的 `time_span`**。周期信息从接口参数迁移为 Bundle 的字段：

| 档位示例 | Bundle | bundle.time_span / time_unit | Pass.expired_time |
|---------|--------|------------------------------|-------------------|
| 试用版  | `bundle_trial_7d` | 7 / "d" | 创建时间 + 7 天 |
| 月卡    | `bundle_basic_1m` | 1 / "m" | 创建时间 + 1 月（自然月） |
| 季卡    | `bundle_basic_3m` | 3 / "m" | 创建时间 + 3 月（自然月） |
| 年卡    | `bundle_basic_12m`| 12 / "m"| 创建时间 + 12 月（自然月） |

**关键设计**：
- 同一产品的不同购买周期通过**不同 Bundle + 不同 Plan** 表达，接口不接收周期参数
- CTL 侧自行基于 `bundle.time_span/time_unit` 计算 `expired_time = now + time_span × time_unit`
- Bundle 与 Plan 的一致性（Plan.period_value == time_span，Plan.period_unit 与 time_unit 映射）在 **ImportBundle 时**由 CTL 强校验（见 [bundle-design.md § 4.7.1.1](bundle-design.md)），运行时两侧到期时间自然对齐
- `time_unit="m"` 按自然月累加（月末溢出处理：3月31 + 1月 = 4月30）；`time_unit="d"` 按自然天累加

### 2.2 Pass 生命周期

```
正常 ──expired_time到期──► 过期
```

> 当前阶段仅支持"正常 → 过期"。`isolated_time` 和 `deleted_time` 作为预留字段，供后续隔离/销毁能力扩展使用。

### 2.3 概念关系

```
Bundle (套餐模板)                Pass (用户权益)                     Shadow Binding
┌─────────────────┐             ┌──────────────────────┐           ┌───────────────┐
│ bundle_id       │ ◄────────  │ bundle_id (关联套餐)   │           │ uin           │
│ bundle_name     │     1:N     │ pass_id              │  冗余存储  │ appid         │
│ agent_quota     │             │ user_id              │ ◄──────── │ user_id       │
│ bundle_state    │             │ uin (冗余)            │           └───────────────┘
└─────────────────┘             │ app_id (冗余)         │
                                │ created_time         │
                                │ expired_time         │
                                │ isolated_time (预留)  │
                                │ deleted_time  (预留)  │
                                │ updated_time         │
                                └──────────────────────┘
```

### 2.5 与 Bundle 的职责划分

| 实体 | 职责 | 生命周期 |
|------|------|---------|
| **Bundle** | 套餐模板定义（名称、描述、Agent 配额、Credit 积分、上下线状态、关联 Plan） | 由运营管理，长期存在 |
| **Pass** | 用户持有的权益实例（谁、哪个套餐、何时到期） | 由购买/赠送产生，到期后失效 |
| **ai-gateway Subscription** | 用户的 AI Token 订阅（由 Pass 创建时联动生成） | 随 Pass 创建，独立到期 |

### 2.6 Credit 与 Token 的映射关系

Pass 本身不存储 `credit` 或 `token` 字段。

- **积分总量** `credit_total` = 关联 Bundle 的 `credit`（模板值，固定）
- **积分余量** `credit_available` = ai-gateway 中该用户当前 active Subscription 的 `token_balance` ÷ `credit_token_ratio`
- 用户可见接口只返回 `credit_total` / `credit_available`；token 数值对用户完全透明

```
Pass.bundle_id ──┐
                 ▼
               Bundle.credit  (模板积分总量)
                 │
                 │ × credit_token_ratio
                 ▼
             ai-gateway Plan.monthly_tokens  (初始 Token 配额)
                 │
                 │ ApplySubscription → 创建
                 ▼
          ai-gateway Subscription.token_balance  (实时余量，随 LLM 调用扣减)
                 │
                 │ ÷ credit_token_ratio
                 ▼
             credit_available  (返回给用户)
```

---

## 3. 数据模型设计

### 3.1 pass 表

| 列名 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | BIGINT | PRIMARY KEY, AUTO_INCREMENT | 自增主键 |
| `pass_id` | VARCHAR(64) | NOT NULL, UNIQUE | 权益唯一标识（业务 ID） |
| `user_id` | VARCHAR(64) | NOT NULL | 持有用户 ID |
| `bundle_id` | VARCHAR(64) | NOT NULL | 关联的套餐 ID |
| `uin` | BIGINT | NOT NULL | 腾讯云用户账号（冗余自 shadow Binding） |
| `app_id` | BIGINT | NOT NULL | 腾讯云应用 ID（冗余自 shadow Binding） |
| `created_time` | DATETIME | NOT NULL, DEFAULT CURRENT_TIMESTAMP | 创建时间 |
| `expired_time` | DATETIME | NOT NULL | 到期时间 |
| `isolated_time` | DATETIME | NULL | 预留：隔离时间（当前阶段不使用） |
| `deleted_time` | DATETIME | NULL | 预留：销毁时间（当前阶段不使用） |
| `updated_time` | DATETIME | NOT NULL, DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP | 更新时间 |

**索引设计**：

| 索引名 | 类型 | 列 | 说明 |
|--------|------|-----|------|
| `uk_pass_id` | UNIQUE | `pass_id` | 按业务 ID 唯一查询 |
| `idx_user_id` | INDEX | `user_id` | 查询某用户的所有 Pass |
| `idx_bundle_id` | INDEX | `bundle_id` | 查询某套餐的所有 Pass |
| `idx_app_id` | INDEX | `app_id` | 按腾讯云应用 ID 查询（计费交互高频场景） |

### 3.2 DDL 预览

#### 000014_create_pass.up.sql

```sql
CREATE TABLE IF NOT EXISTS `pass` (
    `id`              BIGINT       NOT NULL AUTO_INCREMENT,
    `pass_id`         VARCHAR(64)  NOT NULL,
    `user_id`         VARCHAR(64)  NOT NULL,
    `bundle_id`       VARCHAR(64)  NOT NULL,
    `uin`             BIGINT       NOT NULL COMMENT '腾讯云用户账号（冗余自 shadow Binding）',
    `app_id`          BIGINT       NOT NULL COMMENT '腾讯云应用 ID（冗余自 shadow Binding）',
    `created_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `expired_time`    DATETIME     NOT NULL,
    `isolated_time`   DATETIME     NULL     COMMENT '预留：隔离时间',
    `deleted_time`    DATETIME     NULL     COMMENT '预留：销毁时间',
    `updated_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_pass_id` (`pass_id`),
    KEY `idx_user_id` (`user_id`),
    KEY `idx_bundle_id` (`bundle_id`),
    KEY `idx_app_id` (`app_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

#### 000014_create_pass.down.sql

```sql
DROP TABLE IF EXISTS `pass`;
```

---

## 4. 代码层设计

### 4.1 Model 层

#### 目录结构

```
ctl/pkg/model/
├── pass/
│   ├── entity.go          # Pass Entity 定义 + 常量
│   └── dao.go             # Pass DAO 接口 + 实现
```

#### Pass Entity

```go
package pass

import (
    "time"

    "ctl/pkg/model"
)

const (
    TableName = "pass"

    ColumnPassID       = "pass_id"
    ColumnUserID       = "user_id"
    ColumnBundleID     = "bundle_id"
    ColumnUin          = "uin"
    ColumnAppID        = "app_id"
    ColumnExpiredTime  = "expired_time"
    ColumnIsolatedTime = "isolated_time"  // 预留
    ColumnDeletedTime  = "deleted_time"   // 预留
)

type Entity struct {
    model.BaseEntity

    PassID       string     `gorm:"column:pass_id;uniqueIndex:uk_pass_id"`
    UserID       string     `gorm:"column:user_id;index:idx_user_id"`
    BundleID     string     `gorm:"column:bundle_id;index:idx_bundle_id"`
    Uin          int64      `gorm:"column:uin"`
    AppID        int64      `gorm:"column:app_id;index:idx_app_id"`
    ExpiredTime  time.Time  `gorm:"column:expired_time"`
    IsolatedTime *time.Time `gorm:"column:isolated_time"` // 预留
    DeletedTime  *time.Time `gorm:"column:deleted_time"`  // 预留
}

func (Entity) TableName() string {
    return TableName
}
```

> **设计说明**：
> - `IsolatedTime` 和 `DeletedTime` 使用 `*time.Time` 指针类型，`nil` 表示未设置。当前阶段作为预留字段，不在业务逻辑中使用。

### 4.2 DAO 层

```go
package pass

import (
    "fmt"

    "ctl/pkg/model"

    quota "ctl/pkg/model/userresourcequota"

    "gorm.io/gorm"
    "gorm.io/gorm/clause"
)

type Dao interface {
    model.Dao

    GetByPassID(passID string) (*Entity, error)
    ListByUserID(userID string) ([]*Entity, error)
    ListByBundleID(bundleID string) ([]*Entity, error)
    ListByAppID(appID int64) ([]*Entity, error)
    Create(entity *Entity) error
    UpdateByPassID(passID string, updates map[string]interface{}) error

    // CreatePassWithQuota 在同一事务中插入 pass 记录并替换更新配额
    // agentQuota 为 Bundle 的 agent_quota 值（最大配额上限，替换语义）
    CreatePassWithQuota(entity *Entity, userID string, agentQuota int64) error
}

type dao struct {
    *model.BaseDao
}

func NewDao() Dao {
    return &dao{
        BaseDao: model.NewBaseDao(TableName).SetKeyColumn(ColumnPassID),
    }
}

func (d *dao) GetByPassID(passID string) (*Entity, error) {
    var entity Entity
    if err := d.SelectByKeyColumn(passID, &entity); err != nil {
        return nil, err
    }
    return &entity, nil
}

func (d *dao) ListByUserID(userID string) ([]*Entity, error) {
    var entities []*Entity
    if err := d.SimpleQueryAnd(&entities, model.WhereEqual(ColumnUserID, userID)); err != nil {
        return nil, err
    }
    return entities, nil
}

func (d *dao) ListByBundleID(bundleID string) ([]*Entity, error) {
    var entities []*Entity
    if err := d.SimpleQueryAnd(&entities, model.WhereEqual(ColumnBundleID, bundleID)); err != nil {
        return nil, err
    }
    return entities, nil
}

func (d *dao) ListByAppID(appID int64) ([]*Entity, error) {
    var entities []*Entity
    if err := d.SimpleQueryAnd(&entities, model.WhereEqual(ColumnAppID, appID)); err != nil {
        return nil, err
    }
    return entities, nil
}

func (d *dao) Create(entity *Entity) error {
    return d.Insert(entity)
}

func (d *dao) UpdateByPassID(passID string, updates map[string]interface{}) error {
    return d.UpdateByKeyColumn(updates, passID)
}

// CreatePassWithQuota 在同一事务中：
// 1. 插入 pass 记录
// 2. 更新 user_resource_quota（替换语义 + 并发安全）：
//    - 先 INSERT IGNORE 确保配额记录存在（首次购买时创建）
//    - 再 UPDATE 带 WHERE available + (agentQuota - total) >= 0 条件
//      total = agentQuota, available = available + (agentQuota - total)
//    - WHERE 条件保证并发场景下 available 不会变为负数
func (d *dao) CreatePassWithQuota(entity *Entity, userID string, agentQuota int64) error {
    return d.DB().Transaction(func(tx *gorm.DB) error {
        // 1. 插入 pass
        if err := tx.Create(entity).Error; err != nil {
            return fmt.Errorf("insert pass: %w", err)
        }

        // 2a. 确保配额记录存在（INSERT IGNORE）
        //     首次购买时 total=0, available=0，后续 UPDATE 会设置正确的值
        if err := tx.Clauses(clause.OnConflict{
            Columns: []clause.Column{
                {Name: quota.ColumnUserID},
                {Name: quota.ColumnResourceName},
                {Name: quota.ColumnResourceKey},
            },
            DoNothing: true,
        }).Create(&quota.Entity{
            UserID:                 userID,
            ResourceName:           "OPENCLAW_INSTANCE",
            ResourceKey:            "",
            ResourceQuotaAvailable: 0,
            ResourceQuotaTotal:     0,
        }).Error; err != nil {
            return fmt.Errorf("ensure quota record: %w", err)
        }

        // 2b. 原子更新配额（带 WHERE 条件保证 available >= 0）
        //     available = available + (agentQuota - total)  -- 差值调整
        //     total     = agentQuota                        -- 替换为新上限
        //     WHERE available + (agentQuota - total) >= 0   -- 并发安全：确保更新后 available 不为负
        result := tx.Model(&quota.Entity{}).
            Where(
                quota.ColumnUserID+" = ? AND "+quota.ColumnResourceName+" = ? AND "+quota.ColumnResourceKey+" = ? AND "+
                    quota.ColumnResourceQuotaAvailable+" + (? - "+quota.ColumnResourceQuotaTotal+") >= 0",
                userID, "OPENCLAW_INSTANCE", "", agentQuota,
            ).
            Updates(map[string]interface{}{
                quota.ColumnResourceQuotaAvailable: gorm.Expr(
                    quota.ColumnResourceQuotaAvailable+" + (? - "+quota.ColumnResourceQuotaTotal+")",
                    agentQuota,
                ),
                quota.ColumnResourceQuotaTotal: agentQuota,
            })
        if result.Error != nil {
            return fmt.Errorf("update quota: %w", result.Error)
        }
        if result.RowsAffected == 0 {
            // WHERE 条件不满足：consumed > agentQuota，更新后 available 会变负
            return fmt.Errorf("quota update rejected: consumed exceeds new agent_quota")
        }

        return nil
    })
}
```

> **设计说明**：
> - DAO 使用项目标准的 `BaseDao` + `SetKeyColumn` 模式，业务主键为 `pass_id`。
> - `ListByUserID` 查询某用户所有 Pass，`ListByBundleID` 查询某套餐的所有 Pass。
> - `ListByAppID` 按腾讯云应用 ID 查询 Pass，用于计费交互等高频场景，命中 `idx_app_id` 索引。
> - **`CreatePassWithQuota`** 在同一数据库事务中完成 pass 插入和配额更新：
>   - **步骤 2a**：`INSERT IGNORE` 确保配额记录存在（首次购买时 total=0, available=0）
>   - **步骤 2b**：`UPDATE ... WHERE available + (agentQuota - total) >= 0`，原子更新 `total` 和 `available`
>   - **替换语义**：`total` 直接设置为 `agentQuota`，`available` 加上差值 `(agentQuota - old_total)`
>   - **WHERE 条件**保证并发安全：`available + (agentQuota - total) >= 0` 确保更新后 `available` 不会变为负数
>   - 若 WHERE 条件不满足（`RowsAffected == 0`），说明并发场景下 `consumed` 已超过 `agentQuota`，事务回滚
>   - 首次购买时：INSERT IGNORE 创建 (total=0, available=0) → UPDATE 将 total=agentQuota, available=0+(agentQuota-0)=agentQuota
>   - 事务失败时 pass 和配额均回滚

### 4.3 Logic 层

```
ctl/pkg/logic/pass/
└── logic.go               # Pass 业务逻辑
```

#### Pass Logic 接口

```go
type Logic interface {
    // CreateTrialPass 为用户创建试用权益（用户可见 + 后台管理均可调用）
    // 有效期由 Bundle 的 time_span + time_unit 决定，调用方不指定
    CreateTrialPass(userID string, bundleID string) (*PassDetail, error)

    // GetPasses 查询所有 Pass（后台管理用）
    GetPasses(userID *string, bundleID *string) ([]*PassDetail, error)

    // ModifyPass 修改 Pass（如延期、换绑套餐）
    ModifyPass(passID string, req *ModifyPassFields) error

    // DescribePasses 查询当前用户的 Pass 列表（用户可见）
    DescribePasses(userID string) ([]*PassDetail, error)
}

// ModifyPassFields 可修改字段，指针类型
// - nil 表示不修改该字段
// - 非 nil 表示更新为指针指向的值
type ModifyPassFields struct {
    BundleID    *string    `json:"bundle_id,omitempty"`
    ExpiredTime *time.Time `json:"expired_time,omitempty"`
}

type PassDetail struct {
    PassID       string
    UserID       string
    BundleID     string
    Uin          int64
    AppID        int64
    CreatedTime  time.Time
    ExpiredTime  time.Time
    IsolatedTime *time.Time // 预留
    DeletedTime  *time.Time // 预留
    UpdatedTime  time.Time

    // Credit 积分字段（DescribePasses / GetPasses 响应时填充，DB 不存储）
    // 若 bundle.ai_gateway_plan_id 为空或 ai-gateway 查询失败，均返回 0
    CreditTotal     int64 // 积分总量（= bundle.credit）
    CreditAvailable int64 // 积分余量（= token_balance / credit_token_ratio）
}

// CalcExpiredTime 按 Bundle 的 time_span + time_unit 计算 Pass 到期时间
// time_unit="m" → 按自然月累加（月末溢出：3月31 + 1月 = 4月30）
// time_unit="d" → 按自然天累加
func CalcExpiredTime(start time.Time, timeSpan int, timeUnit string) (time.Time, error) {
    if timeSpan <= 0 {
        return time.Time{}, fmt.Errorf("invalid time_span: %d", timeSpan)
    }
    switch timeUnit {
    case "m":
        return addMonthsNatural(start, timeSpan), nil
    case "d":
        return start.AddDate(0, 0, timeSpan), nil
    default:
        return time.Time{}, fmt.Errorf("invalid time_unit: %s", timeUnit)
    }
}

// addMonthsNatural 按自然月累加，目标月无对应日期时取该月最后一天
func addMonthsNatural(start time.Time, months int) time.Time {
    y, m, d := start.Date()
    targetYear, targetMonth := y, m+time.Month(months)
    for targetMonth > 12 {
        targetMonth -= 12
        targetYear++
    }
    maxDay := daysInMonth(targetYear, targetMonth)
    if d > maxDay {
        d = maxDay
    }
    return time.Date(targetYear, targetMonth, d,
        start.Hour(), start.Minute(), start.Second(), start.Nanosecond(), start.Location())
}

func daysInMonth(year int, month time.Month) int {
    return time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC).Day()
}
```

> **设计说明**：
> - `expired_time` 由 CTL 基于 `bundle.time_span` + `bundle.time_unit` 自行计算（`CalcExpiredTime`）
> - `CreateTrialPass` 为**用户可见 + 后台管理均可调用**的接口。完整流程：
>   1. 校验 Bundle 存在且 ONLINE（从 `bundleLogic.GetBundleByID`）
>   2. 静态售罄校验（`bundle.static_sold_out`）
>   3. 原子扣减 `bundle.bundle_sales_available_count`，失败则返回 `ErrBundleSalesQuotaEmpty`；成功后注册 defer 回滚（后续任一步骤失败时 `+1` 回滚）
>   4. 用户唯一 Pass 校验（同一用户只允许一个活跃 Pass）
>   5. 配额校验（`user_resource_quota.consumed` ≤ `bundle.agent_quota`）
>   6. 生成 `pass_id`（`pass-` + 8 位 base36，基于 `id_gen` 表自增 ID 编码）
>   7. 计算 `expired_time = CalcExpiredTime(now, bundle.time_span, bundle.time_unit)`
>   8. 若 `bundle.credit > 0`（必然 `ai_gateway_plan_id` 非空，因 ImportBundle 已校验）：调用 ai-gateway `ApplySubscription(user_id, plan_id)` 开通 Token 订阅；失败则返回错误（defer 回滚 bundle avail_count）
>   9. 若 `bundle.credit == 0`：跳过订阅（ImportBundle 已校验此时 `ai_gateway_plan_id==""`）
>   10. **事务写入**：插入 pass 记录 + INSERT IGNORE 确保配额记录存在 + UPDATE 配额（`WHERE available + (agent_quota - total) >= 0`）
>   11. 成功后取消 defer 回滚，返回 PassDetail
> - `GetPasses` 支持按 `userID` 和/或 `bundleID` 可选筛选，后台管理用。
> - `ModifyPass` 按 `pass_id` 定位单条记录，部分更新（运营仍可手动延期/换绑）。
> - `DescribePasses` 面向用户，按 `user_id` 查询；**返回前调用 ai-gateway 查询 active subscription**，将 `token_balance` 换算为 `credit_available`；`credit_total` 从 `bundle.credit` 直接读取。
> - `isolated_time` / `deleted_time` 作为预留字段保留在 `PassDetail` 中，当前阶段不提供隔离/销毁操作接口。
>
> **Pass 有效期来源（重要）**：
> - `expired_time = CalcExpiredTime(now, bundle.time_span, bundle.time_unit)`（CTL 自行计算）
> - Bundle 与 Plan 的周期一致性已在 ImportBundle 校验，因此 Pass.expired_time 与 Subscription.period_end 天然对齐
> - **用户和调用方都不传周期参数；周期由 Bundle 的 `time_span` + `time_unit` 决定**
>
> **AI Token 订阅联动（严格一致性）**：
> - 创建 Pass 时若 `bundle.credit > 0`，同步调用 ai-gateway Internal API `ApplySubscription` 开通 Token 订阅
> - `bundle.credit == 0` 时跳过订阅开通（ImportBundle 已校验此时 `ai_gateway_plan_id == ""`）
> - CTL 通过 `aiGatewayAdapter` 调用 ai-gateway Internal API，认证方式为 `Bearer <InternalServiceToken>`
> - 需在 `ctl/pkg/adapter/aigateway/adapter.go` 中新增 `GetPlan` / `ApplySubscription` / `CancelSubscription` / `GetActiveSubscription` 方法
> - 需在 CTL 配置中新增 `internal_service_token` 配置项
> - **失败处理策略：严格一致性** — ApplySubscription 失败直接返回错误，触发 defer 回滚 bundle.avail_count；由于步骤 8 在事务写入（步骤 10）之前，此时 pass 尚未写入，无需补偿删除
>
> **配额联动语义**：
> - `resource_name` = `OPENCLAW_INSTANCE`，`resource_key` = `""`，与 Instance 模块共享同一配额行
> - **`agent_quota` 是最大配额上限**（替换语义），不是增量
> - 校验阶段：计算 `consumed = total - available`，若 `consumed > agent_quota` 则拒绝——已消耗量超过新套餐上限，无法安全切换
> - 写入阶段：`total` 直接替换为 `agent_quota`，`available` 加上差值 `(agent_quota - old_total)`
> - 等价于 `available = agent_quota - consumed`，consumed 不变
> - pass 插入与配额更新在**同一数据库事务**中完成，保证原子性

### 4.4 错误码

```
ctl/pkg/errcode/pass.go
```

```go
package errcode

var (
    ErrPassNotFound              = Register(New("PASS_NOT_FOUND", 404, "pass not found"))
    ErrPassInvalidParam          = Register(New("PASS_INVALID_PARAM", 400, "invalid pass parameters"))
    ErrPassExpired               = Register(New("PASS_EXPIRED", 403, "pass has expired"))
    ErrPassBundleOffline         = Register(New("PASS_BUNDLE_OFFLINE", 400, "cannot create pass for offline bundle"))
    ErrPassNoFieldToUpdate       = Register(New("PASS_NO_FIELD_TO_UPDATE", 400, "no field to update"))
    ErrPassShadowBindingNotFound = Register(New("PASS_SHADOW_BINDING_NOT_FOUND", 404, "shadow binding not found for user"))
    ErrPassQuotaExceeded         = Register(New("PASS_QUOTA_EXCEEDED", 403, "consumed quota exceeds bundle agent_quota limit"))
    ErrPassAlreadyExists         = Register(New("PASS_ALREADY_EXISTS", 409, "user already has an active pass"))
)
```

### 4.5 DaoFactory 注册

在 `ctl/pkg/model/factory/factory.go` 中注册新的 DAO：

```go
import (
    passModel "ctl/pkg/model/pass"
)

// 在 Init() 中添加：
PassDao = passModel.NewDao()
```

---

## 5. 与 Bundle / 配额系统的关系

### 5.1 创建 Pass 流程

```
用户购买套餐
    │
    ▼
CreateTrialPass(userID, bundleID)
    │
    ├── 1. 校验 Bundle 存在且 ONLINE，获取 bundle.agent_quota / bundle.credit / bundle.ai_gateway_plan_id
    ├── 2. 静态售罄校验：若 bundle.static_sold_out=true → 报错 ErrPassBundleSoldOut
    ├── 3. 原子扣减 bundle.bundle_sales_available_count：
    │      ├── 成功 → 继续（defer 回滚挂接）
    │      └── 失败 → 报错 ErrBundleSalesQuotaEmpty
    ├── 4. 校验用户是否已有 Pass：
    │      └── 按 userID 查询 pass 表，若存在记录 → 报错 ErrPassAlreadyExists
    ├── 5. 校验配额：
    │      ├── 查询 user_resource_quota (resource_name=OPENCLAW_INSTANCE, resource_key="")
    │      ├── 若记录不存在 → 通过（首次购买，consumed = 0）
    │      ├── 计算 consumed = total - available
    │      ├── 若 consumed > agent_quota → 报错 ErrPassQuotaExceeded
    │      │     （已消耗的配额超过新套餐上限，无法降级）
    │      └── 否则 → 通过
    ├── 6. 生成 pass_id（`pass-` + 8位 base36，基于 id_gen 表自增 ID 编码）
    ├── 7. 计算 expired_time：
    │      └── CalcExpiredTime(now, bundle.time_span, bundle.time_unit)
    │             ├── time_unit="m" → 按自然月累加（月末溢出处理）
    │             └── time_unit="d" → 按自然天累加
    ├── 8. AI Token 订阅联动（事务外）：
    │      ├── 若 bundle.credit == 0 → 跳过
    │      │    （此时 ai_gateway_plan_id 必为 ""，由 ImportBundle 校验保证）
    │      └── 若 bundle.credit > 0 → 调用 ai-gateway ApplySubscription(user_id, plan_id)：
    │             ├── 成功 → 继续（Plan.period 已与 bundle.time_span/unit 一致，
    │             │         因此 subscription.period_end ≈ expired_time）
    │             └── 失败 → 报错（defer 回滚 bundle.avail_count）
    ├── 9. 事务写入：
    │      ├── 插入 pass 记录（pass_id + expired_time + uin + app_id）
    │      └── 创建或更新 user_resource_quota：
    │             ├── 若记录不存在 → INSERT (total=agent_quota, available=agent_quota)
    │             └── 若记录已存在 →
    │                    ├── delta = agent_quota - old_total
    │                    ├── total     = agent_quota          （直接替换为新上限）
    │                    └── available = available + delta     （即 available = agent_quota - consumed）
    ├── 10. 取消 defer 回滚
    └── 11. 返回 PassDetail（含 credit_total = bundle.credit, credit_available = credit_total）
```

> **严格一致性**：订阅联动（步骤 8）在事务写入（步骤 9）之前，若联动失败无需补偿已写入的 pass 行（尚未写入）。仅需 defer 回滚 bundle.avail_count。

> **设计要点**：
> - `pass_id` 生成推迟到步骤 6，确保前置校验全部通过后再生成业务 ID，避免因校验失败导致 ID 浪费。`expired_time` 由 CTL 基于 Bundle 的 `time_span` + `time_unit` 自行计算。
> - 步骤 4 **用户唯一 Pass 校验**：一个用户同一时间仅允许持有一个 Pass。在 `CreateTrialPass` 业务逻辑中通过查询 pass 表校验，不在 DB 层做唯一约束（保留后续扩展灵活性）。
> - **`agent_quota` 是最大配额上限**（替换语义），不是增量。创建 Pass 意味着"将用户的配额上限设定为 `agent_quota`"。
> - 步骤 5 **配额校验语义**：计算已消耗配额 `consumed = total - available`，若 `consumed > agent_quota` 则报错——说明用户当前实际使用量已超过新套餐的上限，无法安全切换。
> - 步骤 9 **配额更新采用替换语义 + WHERE 条件并发保护**：先 INSERT IGNORE 确保记录存在，再 UPDATE 带 `WHERE available + (agent_quota - total) >= 0` 条件。`total` 直接设置为 `agent_quota`，`available` 加上新旧 total 的差值。WHERE 条件保证并发场景下 `available` 不会变为负数，若条件不满足则事务整体回滚。
> - 步骤 9 **pass 插入与配额更新在同一事务中完成**，保证原子性。若事务失败，两者均回滚。
> - `resource_name` 复用现有的 `OPENCLAW_INSTANCE`，`resource_key` 为空字符串，与 Instance 模块的配额体系保持一致。

### 5.2 配额联动设计

当前阶段（本次需求）：
- 创建 Pass 时**同步联动** `user_resource_quota`
- 配额 `resource_name` = `OPENCLAW_INSTANCE`，`resource_key` = `""`，与 Instance 模块共享同一配额行
- **`agent_quota` 是最大配额上限**（替换语义），不是增量
- 创建 Pass 时，根据关联 Bundle 的 `agent_quota` **替换更新**用户配额：
  - `resource_quota_total = agent_quota`（直接覆盖为新上限）
  - `resource_quota_available += (agent_quota - old_total)`（加上差值，等价于 `available = agent_quota - consumed`）
- 替换语义保证了 `consumed`（已消耗配额）不变，`available` 随新上限自动调整

#### 配额更新 SQL 语义

```sql
-- 步骤 2a：确保配额记录存在（INSERT IGNORE）
INSERT INTO user_resource_quota (user_id, resource_name, resource_key, resource_quota_available, resource_quota_total)
VALUES (?, 'OPENCLAW_INSTANCE', '', 0, 0)
ON DUPLICATE KEY UPDATE user_id = user_id;  -- no-op，仅确保记录存在

-- 步骤 2b：原子更新配额（带 WHERE 条件保证并发安全）
UPDATE user_resource_quota
SET resource_quota_available = resource_quota_available + (? - resource_quota_total),
    resource_quota_total     = ?
WHERE user_id = ? AND resource_name = 'OPENCLAW_INSTANCE' AND resource_key = ''
  AND resource_quota_available + (? - resource_quota_total) >= 0;
-- 参数均为 agent_quota
-- WHERE 条件确保更新后 available >= 0，防止并发导致 available 变负
```

> **更新逻辑推导**（假设 `agent_quota = 10`）：
>
> | 场景 | 更新前 total | 更新前 available | consumed | 更新后 total | 更新后 available | consumed |
> |------|-------------|-----------------|----------|-------------|-----------------|----------|
> | 首次购买（无记录） | 0* | 0* | 0 | 10 | 10 | 0 |
> | 原配额 5，未消耗 | 5 | 5 | 0 | 10 | 10 | 0 |
> | 原配额 5，已消耗 2 | 5 | 3 | 2 | 10 | 8 | 2 |
> | 原配额 10，已消耗 3 | 10 | 7 | 3 | 10 | 7 | 3（不变） |
> | 降级到 3，已消耗 2 | 5 | 3 | 2 | 3 | 1 | 2 |
> | 降级到 1，已消耗 2 | 5 | 3 | 2 | **拒绝**（WHERE 不满足：3+(1-5)=-1<0） | — | — |
>
> \* 首次购买时由 INSERT IGNORE 创建 (total=0, available=0)，随后 UPDATE 将其设置为正确的值。

> **并发安全保证**：
> - WHERE 条件 `available + (agent_quota - total) >= 0` 在 MySQL 行级锁下原子求值
> - 若并发的 `AllocQuota`（Instance 消耗）在 UPDATE 之前扣减了 `available`，WHERE 条件会基于**最新的** `available` 和 `total` 求值
> - 若条件不满足（`RowsAffected == 0`），事务整体回滚（pass 也不会写入）
> - 不需要额外的分布式锁或应用层重试

> **与 Instance 模块的配额交互**：
> - Instance 模块使用 `ensureDefaultQuota` + `AllocQuota` 模式：先确保记录存在（默认配额），再原子扣减 `available`（`WHERE available >= cnt`）
> - Pass 模块使用 **INSERT IGNORE + WHERE 条件 UPDATE** 模式：创建 Pass 时将 `total` 设置为 `agent_quota`，`available` 加上差值，WHERE 保证 `available` 不为负
> - 两者操作同一行 `(user_id, OPENCLAW_INSTANCE, "")`，均通过 WHERE 条件保证并发安全——Pass 设定上限，Instance 做消耗扣减

### 5.3 AI Token 订阅联动设计（已启用）

> Bundle 引入 `credit` 字段并关联 ai-gateway Plan 后，创建 Pass 同步开通 Token 订阅；查询 Pass 时实时拉取 Token 余量并换算为 credit 返回用户。

#### 5.3.1 跨系统调用架构

```
CTL (CreateTrialPass)
    │
    │ 步骤 1~3: bundle 校验/扣减（原子+defer 回滚）
    │ 步骤 4~6: Pass 前置校验 + ID 生成
    │ 步骤 7:   计算 expired_time（基于 bundle.time_span + time_unit）
    │ 步骤 8:   AI Token 订阅联动 (HTTP, 事务之前)
    │
    ▼
ai-gateway Internal API   (仅当 bundle.credit > 0 时调用)
    POST /api/internal/subscriptions/apply
    Auth: Bearer <InternalServiceToken>
    Body: { "user_id": "<userID>", "plan_id": "<ai_gateway_plan_id>" }
    │
    ├── 用户不存在 → 自动创建
    ├── 旧订阅存在 → 自动取消
    ├── 根据 Plan 计算 Token 额度（ImportBundle 已校验与 credit 一致）
    └── 创建新 Subscription（period_end 与 CTL 的 expired_time 天然对齐）

┌──────────────────────────────────────────┐
│ 失败 → 返回错误                            │
│   └── CTL defer 回滚 bundle.avail_count   │
│   （pass 尚未写入，无需补偿删除）          │
└──────────────────────────────────────────┘
    │
    │ 步骤 9: 事务写入 (DB)
    │   ├── INSERT pass
    │   └── UPSERT user_resource_quota
    │
    │ 步骤 10~11: 取消 defer + 返回

CTL (DescribePasses)                        ← 新增跨服务调用
    │
    │ 步骤 A: 查 DB 获取 pass 列表
    │ 步骤 B: 对每个 pass (若 bundle.credit > 0)
    │          调 ai-gateway GetActiveSubscription
    │ 步骤 C: credit 换算
    │          credit_total     = bundle.credit
    │          credit_available = TokensToCredit(sub.token_balance)
    │ 步骤 D: 返回 PassDetail（含 credit 字段）
```

#### 5.3.2 CTL Adapter 扩展

在 `ctl/pkg/adapter/aigateway/adapter.go` 中新增方法：

```go
// GetPlan 获取 ai-gateway Plan 详情，供 ImportBundle 校验 monthly_tokens/period 一致性
func (a *adapter) GetPlan(ctx context.Context, planID string) (*Plan, error)

// ApplySubscription 调用 ai-gateway Internal API 为用户开通 Token 订阅
// 幂等：重复调用会取消旧订阅并创建新订阅
func (a *adapter) ApplySubscription(ctx context.Context, userID string, planID string) (*Subscription, error)

// CancelSubscription 调用 ai-gateway Internal API 取消用户的 Token 订阅
// 幂等：用户不存在或无订阅时返回成功
func (a *adapter) CancelSubscription(ctx context.Context, userID string) error

// GetActiveSubscription 获取用户当前 active 订阅，用于查询 token 余量
// 返回 (nil, nil) 表示无 active 订阅
func (a *adapter) GetActiveSubscription(ctx context.Context, userID string) (*Subscription, error)
```

在 `ctl/pkg/adapter/aigateway/types.go` 中新增类型：

```go
type ApplySubscriptionRequest struct {
    UserID string `json:"user_id"`
    PlanID string `json:"plan_id"`
}

type CancelSubscriptionRequest struct {
    UserID string `json:"user_id"`
}

// Subscription 订阅返回体（精简版，CTL 只关心计量字段）
type Subscription struct {
    ID            string    `json:"id"`
    UserID        string    `json:"user_id"`
    PlanID        string    `json:"plan_id"`
    Status        string    `json:"status"`
    TokenBalance  int64     `json:"token_balance"`
    MonthlyTokens int64     `json:"monthly_tokens"`
    PeriodStart   time.Time `json:"period_start"`
    PeriodEnd     time.Time `json:"period_end"`
}
```

#### 5.3.3 认证配置

ai-gateway Internal API 使用独立的 `InternalServiceToken`（区别于现有的 `AdminToken`）：

```toml
# ctl/conf/server/common/server_conf.toml
[adapter.aigateway]
base_url = "http://gateway.ai-gateway.svc.cluster.local"
admin_token = "xxx"                    # 现有：Admin API 认证
internal_service_token = "yyy"         # 新增：Internal API 认证
timeout = 10
```

对应 config 变更：

```go
// ctl/pkg/config/define.go
type AiGatewayConfig struct {
    BaseURL              string `toml:"base_url"`
    AdminToken           string `toml:"admin_token"`
    InternalServiceToken string `toml:"internal_service_token"` // 新增
    Timeout              int    `toml:"timeout"`
}
```

#### 5.3.4 失败处理（严格一致性）

| 场景 | 处理方式 |
|------|---------|
| `bundle.credit == 0` | 跳过 ai-gateway 调用（ImportBundle 已校验 ai_gateway_plan_id==""），pass 正常创建 |
| `InternalServiceToken` 未配置 | `credit > 0` 时返回配置错误，拒绝创建 pass（明确告警而非静默降级） |
| ApplySubscription 成功 | 记录日志（含 subscription_id），正常返回 |
| ApplySubscription 超时/失败 | 返回错误 → defer 回滚 bundle.avail_count → 事务外补偿删除 pass 记录 + 回滚 quota |
| GetActiveSubscription 失败 | `DescribePasses` 对该 pass 返回 `credit_available = 0` + 日志告警，不阻断整个列表返回 |

> **为什么采用严格一致性**：避免 pass 创建成功但用户没有 Token 配额的"可见不一致"状态。DescribePasses 采用"单条容错"避免 ai-gateway 偶发抖动导致整个列表 500。

### 5.4 完整演进路线图

```
当前阶段 (v1)                     当前阶段 (v2)                     后续阶段 (v3)
┌─────────────┐                  ┌─────────────┐                  ┌─────────────┐
│   bundle    │                  │   bundle    │                  │   bundle    │
│ (套餐模板)   │                  │ (套餐模板)   │                  │ (套餐模板)   │
└─────────────┘                  └──────┬──────┘                  └──────┬──────┘
                                        │                                │
                                 ┌──────▼──────┐                  ┌──────▼──────┐
                                 │    pass     │                  │    pass     │
                                 │ (用户权益)   │                  │ (用户权益)   │
                                 └──────┬──────┘                  └──┬───────┬──┘
                                        │                            │       │
                                 ┌──────▼──────┐             ┌──────▼──┐  ┌─▼──────────────┐
                                 │ user_       │             │ user_   │  │  ai-gateway    │
                                 │ resource    │             │ resource│  │  Subscription  │
                                 │ _quota      │             │ _quota  │  │  (Token 订阅)  │
                                 └─────────────┘             └─────────┘  └────────────────┘
                                 配额联动                     到期回收       Token 联动
                                 (替换上限)                   续费/升降级    到期取消订阅
```

> v1（Bundle 阶段）：套餐模板定义，含预留 AI Token 字段。
> v2（当前阶段）：创建 Pass 时同步将 `agent_quota` 作为最大配额上限替换更新。
> v3（后续阶段）：Pass 到期时回收配额 + 续费/升降级；启用 AI Token 联动，创建 Pass 时调用 ai-gateway 开通 Token 订阅。

---

## 6. API 设计

与 Bundle 一致，Pass API 采用**两层架构**：

- **admin-gateway（后台管理）**：面向运营人员，提供创建、查询全量、修改能力。
- **CTL（用户可见）**：面向终端用户，提供创建试用权益和查询自己 Pass 的能力。

> `CreateTrialPass` 同时在用户可见接口和后台管理接口中提供。

```
┌──────────────┐  POST/GET/PUT /admin/api/ctl/passes    ┌──────────┐
│ admin-gateway│ ──────────────────────────────────────► │   CTL    │
│ (运营后台)    │        HTTP Basic Auth                  │ (控制面)  │
└──────────────┘                                         │          │
                                                         │          │
┌──────────────┐  POST /v1/passes (创建)                  │          │
│  用户客户端   │  GET  /v1/passes (查询)                  │          │
│              │ ──────────────────────────────────────► │          │
└──────────────┘                                         └──────────┘
```

### 6.1 后台管理接口（admin-gateway → CTL）

| 方法 | 路径 | 说明 | 对应 Logic |
|------|------|------|-----------|
| `POST` | `/admin/api/ctl/passes` | 为用户创建试用权益 | `CreateTrialPass` |
| `GET`  | `/admin/api/ctl/passes` | 查询 Pass（支持按 user_id/bundle_id 筛选） | `GetPasses` |
| `PUT`  | `/admin/api/ctl/passes` | 修改 Pass（延期、换绑套餐） | `ModifyPass` |

### 6.2 用户可见接口（CTL）

| 方法 | 路径 | 说明 | 对应 Logic |
|------|------|------|-----------|
| `POST` | `/v1/passes` | 创建试用权益 | `CreateTrialPass` |
| `GET` | `/v1/passes` | 查询当前用户的 Pass 列表 | `DescribePasses` |

### 6.3 请求/响应示例

#### 创建试用权益（CreateTrialPass） — 用户可见 / 后台管理

```json
// POST /v1/passes  或  POST /admin/api/ctl/passes
// Request
{
    "user_id": "user-abc123",       // 后台管理时指定；用户接口自动取当前登录用户
    "bundle_id": "basic-5"
    // 不传时长：有效期完全由 Bundle 关联的 Plan 周期决定
}

// Response 200
{
    "pass_id": "pass-xyz789",
    "user_id": "user-abc123",
    "bundle_id": "basic-5",
    "uin": 100012345678,
    "app_id": 1300054321,
    "created_time": "2026-04-17T16:00:00Z",
    "expired_time": "2026-05-17T16:00:00Z",
    "isolated_time": null,
    "deleted_time": null,
    "updated_time": "2026-04-17T16:00:00Z",
    "credit_total": 100,
    "credit_available": 100
}
```

#### 查询 Pass（GetPasses） — 后台管理

```json
// GET /admin/api/ctl/passes?user_id=user-abc123
// 支持可选筛选：user_id、bundle_id
// Response 200
{
    "passes": [
        {
            "pass_id": "pass-xyz789",
            "user_id": "user-abc123",
            "bundle_id": "basic-5",
            "uin": 100012345678,
            "app_id": 1300054321,
            "created_time": "2026-04-17T16:00:00Z",
            "expired_time": "2027-04-17T00:00:00Z",
            "isolated_time": null,
            "deleted_time": null,
            "updated_time": "2026-04-17T16:00:00Z",
            "credit_total": 100,
            "credit_available": 87
        }
    ]
}
```

#### 修改权益（ModifyPass） — 后台管理

```json
// PUT /admin/api/ctl/passes
// 示例：延长到期时间
// Request
{
    "pass_id": "pass-xyz789",
    "expired_time": "2028-04-17T00:00:00Z"
}

// Response 200
{
    "pass_id": "pass-xyz789",
    "user_id": "user-abc123",
    "bundle_id": "basic-5",
    "uin": 100012345678,
    "app_id": 1300054321,
    "created_time": "2026-04-17T16:00:00Z",
    "expired_time": "2028-04-17T00:00:00Z",
    "isolated_time": null,
    "deleted_time": null,
    "updated_time": "2026-04-17T17:00:00Z",
    "credit_total": 100,
    "credit_available": 87
}
```

#### 查询我的权益（DescribePasses） — 用户可见

```json
// GET /v1/passes
// 自动按当前登录用户的 user_id 查询
// Response 200
{
    "passes": [
        {
            "pass_id": "pass-xyz789",
            "user_id": "user-abc123",
            "bundle_id": "basic-5",
            "uin": 100012345678,
            "app_id": 1300054321,
            "created_time": "2026-04-17T16:00:00Z",
            "expired_time": "2027-04-17T00:00:00Z",
            "isolated_time": null,
            "deleted_time": null,
            "updated_time": "2026-04-17T16:00:00Z",
            "credit_total": 100,
            "credit_available": 87
        }
    ]
}
```

> **用户只看到 credit，看不到底层 Token**：
> - `credit_total` 是套餐积分总量（固定值 = `bundle.credit`）
> - `credit_available` 是实时余量，由 CTL 在返回前调 ai-gateway 查询 `token_balance` 并换算
> - 若 ai-gateway 不可达或无订阅，`credit_available` 返回 0，不阻断查询

---

## 7. 测试要点

### 7.1 单元测试

| 测试项 | 验证内容 |
|--------|---------|
| CreateTrialPass 正常（月卡） | Bundle `time_span=1, time_unit="m"`，创建成功，expired_time ≈ now + 1 月（自然月） |
| CreateTrialPass 月末溢出 | 3月31日创建 time_span=1, time_unit="m" 的 Pass → expired_time = 4月30 |
| CreateTrialPass 天数套餐 | Bundle `time_span=7, time_unit="d"`，expired_time ≈ now + 7 天 |
| CreateTrialPass 季卡/年卡 | time_span=3 / 12 单位 "m"，expired_time 为相应自然月数后 |
| CreateTrialPass Bundle 不存在 | 返回错误 |
| CreateTrialPass Bundle OFFLINE | 返回 `ErrPassBundleOffline` |
| CreateTrialPass credit=0 | Bundle `credit=0, ai_gateway_plan_id=""` → 跳过 ai-gateway，pass 正常创建 |
| CreateTrialPass 用户已有 Pass | 用户已有一条 Pass 记录 → 返回 `ErrPassAlreadyExists` |
| CreateTrialPass uin/app_id 字段 | 当前暂置 0（后续接入 shadow 后补充） |
| CreateTrialPass 配额不存在 | 用户无配额记录 → 创建成功，配额 INSERT (total=agent_quota, available=agent_quota) |
| CreateTrialPass 配额扩容 | 用户 total=5 available=3 (consumed=2)，agent_quota=10 → 创建成功，total=10 available=8 (consumed 仍=2) |
| CreateTrialPass 配额不变 | 用户 total=10 available=7 (consumed=3)，agent_quota=10 → 创建成功，total=10 available=7 (不变) |
| CreateTrialPass 配额降级成功 | 用户 total=10 available=8 (consumed=2)，agent_quota=5 → 创建成功，total=5 available=3 (consumed 仍=2) |
| CreateTrialPass 配额降级失败 | 用户 total=10 available=7 (consumed=3)，agent_quota=2 → consumed(3) > agent_quota(2)，返回 `ErrPassQuotaExceeded` |
| CreateTrialPass 配额与 Pass 原子性 | 事务中任一步骤失败，pass 和配额均不变 |
| CreateTrialPass AI Token 联动成功 | Bundle `credit>0`，创建 Pass 后 ai-gateway 返回 Subscription；`credit_total = bundle.credit` |
| CreateTrialPass AI Token 联动失败回滚 | ai-gateway 调用失败 → bundle avail_count 回滚 + pass 未写入 + 返回错误（严格一致） |
| CreateTrialPass 周期对齐 | 检查 Pass.expired_time 与 ai-gateway Subscription.period_end 差值 < 1 秒（ImportBundle 校验保证） |
| CreateTrialPass InternalToken 未配置 | `credit > 0` 但配置缺失 → 返回配置错误，拒绝创建 |
| CalcExpiredTime 合法 time_unit="m" | 按自然月累加 |
| CalcExpiredTime 合法 time_unit="d" | 按自然天累加 |
| CalcExpiredTime 非法 time_unit | 返回错误（理论不会发生，因 ImportBundle 已校验） |
| DescribePasses credit 换算 | 调 ai-gateway 查 subscription 后 `credit_available = token_balance / ratio`（向下取整） |
| DescribePasses credit 初始值 | 刚创建的 Pass → `credit_available == credit_total == bundle.credit` |
| DescribePasses ai-gateway 不可达 | ai-gateway 调用失败 → 该 pass 的 `credit_available` 返回 0 + 日志告警，不阻断整个列表 |
| DescribePasses 无 active subscription | ai-gateway 返回无订阅 → `credit_available = 0` |
| ModifyPass 延期 | 传 `expired_time`，更新成功 |
| ModifyPass 换绑 | 传 `bundle_id`，更新为新套餐 |
| ModifyPass 无字段 | 所有字段为 nil，返回 `ErrPassNoFieldToUpdate` |
| ModifyPass 不存在 | 返回 `ErrPassNotFound` |
| GetPasses 按 user_id | 仅返回该用户的 Pass |
| GetPasses 按 bundle_id | 仅返回该套餐的 Pass |
| GetPasses 无筛选 | 返回全部 Pass |
| DescribePasses | 返回指定用户的所有 Pass |

### 7.2 集成测试

| 测试项 | 验证内容 |
|--------|---------|
| 完整生命周期 | 创建 Bundle → 上线 Bundle → 创建试用 Pass → 查询 Pass → 修改 Pass → 验证更新 |
| 多用户多 Pass | 多个用户购买同一 Bundle，各自有独立 Pass 和独立配额设定 |
| Bundle 下线后 | 已创建的 Pass 不受影响，但不能再创建新 Pass |
| admin-gateway 代理验证 | 通过 `/admin/api/ctl/passes` 调用管理接口，验证代理转发正确 |
| 用户接口创建试用 Pass | 通过 `/v1/passes` 创建试用权益，验证 user_id 自动取当前登录用户 |
| 权限隔离 | 用户接口 `/v1/passes` 仅能查自己的，不能查他人的 |
| AppID 查询 | 按 `app_id` 查询 Pass，验证 `idx_app_id` 索引命中，模拟计费场景按应用 ID 检索 |
| 配额首次创建 | 新用户无配额记录 → 创建 Pass → 配额记录自动创建，total 和 available 均等于 agent_quota |
| 配额替换更新 | 用户已有 total=5 → 创建 agent_quota=10 的 Pass → total=10，available 增加 5（差值），consumed 不变 |
| 配额与 Instance 共存 | 用户先创建 Instance（AllocQuota 扣减 available），再创建 Pass → total 替换为 agent_quota，available = agent_quota - consumed |
| 配额降级拒绝 | 用户 consumed > agent_quota → 创建 Pass 返回 `ErrPassQuotaExceeded` |
| AI Token 完整联动 | 创建含 credit + ai_gateway_plan_id 的 Bundle → 上线 → 创建 Pass → 验证 ai-gateway Subscription 已创建，`DescribePasses` 返回 credit_total/credit_available |
| AI Token 联动幂等 | 对同一用户重复创建 Pass（逻辑上被 ErrPassAlreadyExists 阻止；但 ai-gateway 侧 ApplySubscription 幂等语义保留，避免数据漂移） |
| AI Token 联动失败回滚 | mock ai-gateway 返回 500 → bundle avail_count 回滚 + 无 pass 记录 + 接口返回错误 |
| credit 实时展示 | 用户调 LLM 消耗 token 后，再调 `GET /v1/passes` 查看 credit_available 已下降 |
| DescribePasses 部分容错 | 1 个 bundle 有 plan、1 个 bundle 无 plan → 有 plan 的返回 credit，无 plan 的返回 0 |
| ai-gateway 故障容错 | 关停 ai-gateway，`GET /v1/passes` 仍能返回列表，credit_available=0 + 日志记录告警 |

---

## 8. 影响评估

| 影响范围 | 影响程度 | 说明 |
|---------|---------|------|
| 数据库 | 新增 1 张表 | `pass` 表（含 `isolated_time` / `deleted_time` 预留字段），不影响现有表 |
| CTL Model 层 | 新增 1 个 model 包 | `pass/entity.go` + `pass/dao.go` |
| CTL Logic 层 | 新增 1 个 logic 包 | `logic/pass/logic.go`，依赖 Bundle DAO（校验 Bundle 状态） |
| CTL API 层 | 新增管理接口 + 用户接口 | 管理 `/admin/api/ctl/passes`，用户 `/v1/passes` |
| admin-gateway | 新增代理路由 | `/admin/api/ctl/passes` → CTL |
| Bundle 模块 | 读写依赖 | CreateTrialPass 校验 Bundle + 扣减 `bundle_sales_available_count` + 回滚；DescribePasses 需读取 `bundle.credit` |
| shadow 服务 | 当前**已解耦** | `uin` / `app_id` 暂置 0，后续接入 shadow 时补充（不影响 pass 主流程） |
| ai-gateway 服务 | **写入 + 读取依赖** | CreateTrialPass 调 `ApplySubscription` 开通订阅；DescribePasses 调 `GetActiveSubscription` 查 token_balance 换算为 credit |
| CTL Adapter 层 | 扩展 | `adapter/aigateway` 新增 `GetPlan` / `ApplySubscription` / `CancelSubscription` / `GetActiveSubscription` 方法 |
| CTL 配置 | 扩展 | `adapter.aigateway` 新增 `internal_service_token`；`[bundle]` 新增 `credit_token_ratio` |
| 现有配额系统 | **写入依赖** | 创建 Pass 时 UPSERT `user_resource_quota`，将 `agent_quota` 作为最大配额上限替换 `total`，`available` 加上差值，与 Instance 模块共享 `OPENCLAW_INSTANCE` 配额行 |
| 前端 | 需适配 | Pass 查询响应新增 `credit_total` / `credit_available` 字段供展示 |

---

## 9. 实施计划

| 阶段 | 任务 | 产出 |
|------|------|------|
| 1 | 数据库 migration | `000014_create_pass.up.sql` / `.down.sql` |
| 2 | Model 层 | `pass/entity.go`（`Entity`）, `pass/dao.go`（`Dao`） |
| 3 | DaoFactory 注册 | `factory.go` 新增注册 |
| 4 | Logic 层基础能力 | `logic/pass/logic.go`（Create/Get/Modify/Describe + bundle 限量联动） |
| 5 | 错误码 | `errcode/pass.go` |
| 6 | 单元测试（基础） | DAO 测试 + Logic 测试（不含 ai-gateway 联动） |
| 7 | CTL 用户接口 | `POST /v1/passes`（CreateTrialPass）+ `GET /v1/passes`（DescribePasses） |
| 8 | CTL 管理接口 | `POST/GET/PUT /admin/api/ctl/passes` handler |
| 9 | admin-gateway 路由配置 | 新增 `/admin/api/ctl/passes` → CTL 的反向代理规则 |
| 10 | 集成测试（基础） | 端到端验证（含 admin-gateway 代理链路、bundle avail_count 扣减/回滚） |
| 11 | ai-gateway Adapter 扩展 | `adapter/aigateway/adapter.go` 新增 `ApplySubscription` / `CancelSubscription` / `GetActiveSubscription` |
| 12 | CTL 配置扩展 | `config/define.go` 新增 `InternalServiceToken`（adapter.aigateway 段）+ `BundleConfig.CreditTokenRatio`（bundle 段） |
| 13 | CreateTrialPass 接入订阅联动 | 步骤 9：`ai_gateway_plan_id` 非空时调 `ApplySubscription`，失败则触发 defer 回滚 bundle + 补偿删除 pass |
| 14 | DescribePasses 接入 credit 换算 | 返回前批量调 `GetActiveSubscription`，`credit_available = token_balance / ratio`；失败则 credit_available=0 不阻断 |
| 15 | AI Token 联动测试 | 单元 + 集成测试，覆盖成功、失败回滚、ai-gateway 不可用、多个 pass credit 并行换算等 |

> **注**：Pass 的实施应在 Bundle（000013）+ Bundle credit migration（000016）之后进行，确保 Bundle 表和相关 Logic 已就绪。

---

## 10. 开放问题

| # | 问题 | 待确认 |
|---|------|--------|
| 1 | ~~`pass_id` 生成规则？~~ | **已确定**：使用 `pass-` 前缀 + 8 位 base36 字符串，基于 `id_gen` 表自增 ID + 可逆加密编码（如 `pass-jyxpuid0`） |
| 2 | ~~一个用户能否同时持有多个相同 Bundle 的 Pass？~~ | **已确定**：一个用户同一时间仅允许持有一个 Pass。在 `CreateTrialPass` 中做业务校验（按 `userID` 查询 pass 表），不在 DB 层做唯一约束 |
| 3 | Pass 到期后的处理策略？ | 到期后仅标记过期由业务侧按 `expired_time` 判断？是否需要后台定时任务？ |
| 4 | Pass 到期后配额回收方式？ | 到期时是否自动减少 `total` 和 `available`？是否需要定时任务扫描过期 Pass 并回收配额？若 `available` 已被消耗低于回收量，如何处理？ |
| 5 | `uin` / `app_id` 与 shadow Binding 的一致性？ | Pass 中的 `uin` / `app_id` 是创建时的快照（当前已解耦，暂置 0）。接入 shadow 后，若 shadow 侧后续发生账号迁移，是否需要同步更新 Pass 中的冗余值？建议暂不自动同步，必要时由运营通过 ModifyPass 手动订正 |
| 6 | 预留字段的启用时机？ | `isolated_time` 和 `deleted_time` 作为预留字段，何时启用隔离/销毁能力？是否需要配套 `history_pass` 归档表？ |
| 7 | ~~配额校验的竞态处理？~~ | **已解决**：配额 UPDATE 使用 `WHERE available + (agent_quota - total) >= 0` 条件，在 MySQL 行级锁下原子求值，保证并发场景下 `available` 不会变为负数 |
| 8 | ~~AI Token 订阅与 Pass 的到期时间是否对齐？~~ | **已解决（方案 A）**：Pass 不再接受 `time_span`，`expired_time` 直接取 `ApplySubscription` 响应中的 `period_end`，两侧时间自然一致。不同购买周期通过不同 Bundle（关联不同 Plan）表达 |
| 9 | Pass 到期时是否自动取消 ai-gateway 订阅？ | 当前 Pass 到期仅标记过期。是否需要定时任务扫描过期 Pass 并调 `CancelSubscription`？ai-gateway 自身也有 Scheduler 每 5 分钟检查过期订阅，两侧独立过期；可接受短期不一致 |
| 10 | CreatePass 事务失败时 pass 记录的补偿策略？ | ApplySubscription 失败后，pass 记录与 quota 变更已在事务中写入，需事务外补偿 DELETE + 回滚 quota。目前设计：同请求内同步补偿；若补偿失败则记录告警日志（不阻塞用户）。需验证补偿的可靠性 |
| 11 | `credit_token_ratio` 后续若需调整如何处理？ | 若运营想把比例从 10000 改成 5000，历史已开通的 Subscription `token_balance` 不变，新配置只影响新开通订阅和 credit 展示换算。需避免频繁调整；建议在 ImportBundle 约束中提示运营保持 `Plan.monthly_tokens = credit × ratio` 一致 |
| 12 | 不同 Bundle 是否可以关联同一个 ai-gateway Plan？ | 当前设计允许（`ai_gateway_plan_id` 无唯一约束）。但这意味着换 Bundle 时 Plan 可能不变，`ApplySubscription` 也不变。若需要严格隔离，可在运营规范中要求一对一 |
