# Bundle 权益套餐包 — 需求设计文档

> 日期：2026-04-17（2026-04-19 更新：新增 credit 积分体系）  
> 状态：已实现（limit/回滚/cron）+ 设计中（credit 积分）  
> 归属服务：CTL (控制面) + admin-gateway (后台管理代理) + ai-gateway (Token 订阅)

---

## 1. 需求背景

当前系统中用户的 Agent 创建配额是通过 `user_resource_quota` 表硬编码管理的（默认每用户 5 个 `OPENCLAW_INSTANCE`）。这种方式存在以下问题：

- **配额与商品脱钩**：无法按套餐粒度管理不同的权益组合
- **缺乏灵活性**：无法区分不同级别的套餐（免费版 / 基础版 / 专业版等）
- **运营能力缺失**：无法对套餐进行上下线管理

需要引入 **Bundle（权益套餐包）** 的概念，作为配额管理与商品体系之间的桥梁。

---

## 2. 核心概念

### 2.1 Bundle（权益套餐包）

Bundle 是一个**可运营的权益容器**，代表一个套餐包的完整定义，包括基本信息、生命周期状态和权益配置。

- 每个 Bundle 通过 `bundle_id` 唯一标识
- `bundle_name` 为套餐展示名称（如"体验版"、"基础版"）
- `description` 为 JSON 字符串，存储套餐的结构化描述信息，格式为 KV 数组：`[{"Key": "体验Agent", "Value": "至多1个"}]`
- Bundle 有上线（ONLINE）和下线（OFFLINE）两种状态
- Bundle 是静态配置，不绑定到具体用户
- 当前包含两个权益维度：
  - `agent_quota`（用户可创建的 Agent 配额数）
  - `credit`（用户可见的积分额度，通过 credit↔token 固定比例换算映射到 ai-gateway 的 Token 配额）
- 套餐周期字段（决定 Pass 有效期）：
  - `time_span`：周期数值（如 `1`、`3`、`12`）
  - `time_unit`：周期单位，取值 `"m"`（月）或 `"d"`（天）
  - 创建 Pass 时 `expired_time = now + time_span × time_unit`
  - 月份按自然月计算（3月31 + 1月 = 4月30），天数按自然天计算
- **credit 与 AI Token 联动**：
  - `credit` 是**用户可见**的统一积分概念；`token` 是 ai-gateway 内部的计量单位，对用户不可见
  - 转换比例 `credit_token_ratio` 由 CTL 全局配置提供（如 `1 credit = 10000 token`）
  - `ai_gateway_plan_id` 为 Bundle 关联的 ai-gateway Plan UUID
  - **ImportBundle 强校验**（见 4.7.1.1 节）：
    - `credit == 0` 时：`ai_gateway_plan_id` 必须为空（无 Token 权益套餐）
    - `credit > 0` 时：`ai_gateway_plan_id` 必须非空，且 Plan 的 `monthly_tokens == credit × credit_token_ratio`，Plan 的 `period_value/period_unit` 必须与 Bundle 的 `time_span/time_unit` 一致
- `static_sold_out` 为静态售罄标记，由运营手动控制
- `bundle_sales_available_count` / `bundle_sales_total_count` 代表套餐每天可售卖的数量
  - 创建 Pass 时原子扣减 `bundle_sales_available_count`，若失败（=0）则拒绝售卖
  - 每天 10:00（UTC+8）由 CTL 内置定时任务将所有 ONLINE 套餐的 `bundle_sales_available_count` 刷新为 `bundle_sales_total_count`
- 用户查询时会返回计算字段 `bundle_sales_state`（`AVAILABLE` / `SOLD_OUT`），当 `static_sold_out = true` 或 `bundle_sales_available_count <= 0` 时返回 `SOLD_OUT`
- 后续如需扩展权益维度（如存储配额等），直接 `ALTER TABLE ADD COLUMN` 即可

### 2.2 设计决策：单表 vs 分表

| 维度 | 单表（✅ 采用） | 分表 |
|------|--------------|------|
| 复杂度 | 1 张表、1 个 model、1 个 DAO | 2 张表、2 个 model、2 个 DAO |
| 查询性能 | 单表查询，无 JOIN | 需要 JOIN 或二次查询 |
| 事务安全 | 单行操作天然原子 | 跨表操作需显式事务 |
| 权益扩展 | `ALTER TABLE ADD COLUMN` | 同理 |
| YAGNI | ✅ 不过度设计 | 为不确定的未来提前付出成本 |

> 当前只有一个权益维度 `agent_quota`，不值得拆成两张表。如果未来真的需要 1:N 的配置模型，拆表迁移成本很低（一条 migration + 一个新 model），远低于现在就维护双表的持续成本。

### 2.3 概念关系

```
Bundle (套餐)
  ├── bundle_id:                     唯一标识
  ├── bundle_name:                   套餐名称
  ├── description:                   结构化描述 (JSON)
  ├── bundle_state:                  上线 / 下线
  ├── agent_quota:                   用户可创建的 Agent 数量
  ├── credit:                        用户可见的积分额度（对应 credit × ratio 个 Token）
  ├── time_span:                     周期数值（如 1, 3, 12）
  ├── time_unit:                     周期单位（"m"=月 / "d"=天）
  ├── ai_gateway_plan_id:            关联 ai-gateway Plan UUID（credit=0 时允许空）
  ├── static_sold_out:               静态售罄标记 (运营手动控制)
  ├── bundle_sales_available_count:  当日可售卖余量
  ├── bundle_sales_total_count:      每日可售卖总量
  └── [计算] bundle_sales_state:     AVAILABLE / SOLD_OUT

        │ ai_gateway_plan_id（ImportBundle 时强校验三项一致性）
        ▼
ai-gateway Plan (Token 额度配置)
  ├── id:               Plan UUID (= bundle.ai_gateway_plan_id)
  ├── monthly_tokens:   每月 Token 额度   ←→ 必须 = bundle.credit × ratio
  ├── period_value:     周期数值          ←→ 必须 = bundle.time_span
  ├── period_unit:      周期单位          ←→ 必须 = bundle.time_unit 映射值
  │                    ("m" → "months", "d" → "days")
  ├── allowed_models:   允许的模型列表
  └── token_multipliers: 各模型 Token 倍率

        │ 创建 Pass 时触发 ApplySubscription
        ▼
ai-gateway Subscription (用户订阅)
  ├── user_id:          用户
  ├── plan_id:          绑定的 Plan
  ├── token_balance:    剩余 Token（查询时换算为 credit 余额返回给用户）
  └── period_end:       订阅到期时间
```

> **注**：当前阶段已建立"用户订购 Bundle"的关联（Pass），并将创建 Pass 与 ai-gateway 的 `ApplySubscription` 同步联动，实现 credit → Token 的转换落地。

> **Pass 有效期公式**：
> - `Pass.expired_time = now + bundle.time_span × bundle.time_unit`
> - time_unit="m" → 按自然月累加（处理月末溢出：3月31 + 1月 = 4月30）
> - time_unit="d" → 按自然天累加

> **credit ↔ token 转换规则**：
> - 系统全局比例 `credit_token_ratio` 由 `server_conf.toml` 配置，默认 `10000`
> - `credit = token / credit_token_ratio`（向下取整）
> - `token = credit × credit_token_ratio`
> - 转换对用户不可见；用户只看 credit，token 为内部计量单位

---

## 3. 数据模型设计

### 3.1 bundle 表

| 列名 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | BIGINT | PRIMARY KEY, AUTO_INCREMENT | 自增主键 |
| `bundle_id` | VARCHAR(64) | NOT NULL, UNIQUE | 套餐唯一标识（业务 ID） |
| `bundle_name` | VARCHAR(128) | NOT NULL, DEFAULT '' | 套餐展示名称 |
| `description` | TEXT | NOT NULL | 套餐结构化描述，JSON 格式 `[{"Key":"...","Value":"..."}]` |
| `bundle_state` | VARCHAR(32) | NOT NULL, DEFAULT 'OFFLINE' | 套餐状态：`ONLINE` / `OFFLINE` |
| `agent_quota` | BIGINT | NOT NULL, DEFAULT 0 | 该套餐授予的 Agent 创建配额数 |
| `credit` | BIGINT | NOT NULL, DEFAULT 0 | 用户可见的积分额度（对应 `credit × ratio` 个 Token） |
| `time_span` | INT | NOT NULL, DEFAULT 1 | 套餐周期数值（如 1、3、12） |
| `time_unit` | VARCHAR(2) | NOT NULL, DEFAULT 'm' | 套餐周期单位：`'m'`=月，`'d'`=天 |
| `ai_gateway_plan_id` | VARCHAR(64) | NOT NULL, DEFAULT '' | 关联 ai-gateway Plan UUID（仅 `credit=0` 时允许空） |
| `static_sold_out` | TINYINT(1) | NOT NULL, DEFAULT 0 | 静态售罄标记：0=未售罄，1=售罄（运营手动控制） |
| `bundle_sales_available_count` | INT | NOT NULL, DEFAULT 0 | 当日可售卖余量 |
| `bundle_sales_total_count` | INT | NOT NULL, DEFAULT 0 | 每日可售卖总量 |
| `created_time` | DATETIME | NOT NULL, DEFAULT CURRENT_TIMESTAMP | 创建时间 |
| `updated_time` | DATETIME | NOT NULL, DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP | 更新时间 |

**索引设计**：

| 索引名 | 类型 | 列 | 说明 |
|--------|------|-----|------|
| `uk_bundle_id` | UNIQUE | `bundle_id` | 按业务 ID 唯一查询 |
| `idx_bundle_state` | INDEX | `bundle_state` | 按状态筛选（如列出所有上线套餐） |

### 3.2 DDL 预览

#### 000013_create_bundle.up.sql

```sql
CREATE TABLE IF NOT EXISTS `bundle` (
    `id`                           BIGINT       NOT NULL AUTO_INCREMENT,
    `bundle_id`                    VARCHAR(64)  NOT NULL,
    `bundle_name`                  VARCHAR(128) NOT NULL DEFAULT '',
    `description`                  TEXT         NOT NULL,
    `bundle_state`                 VARCHAR(32)  NOT NULL DEFAULT 'OFFLINE',
    `agent_quota`                  BIGINT       NOT NULL DEFAULT 0,
    `ai_gateway_plan_id`           VARCHAR(64)  NOT NULL DEFAULT '',
    `monthly_tokens`               BIGINT       NOT NULL DEFAULT 0,
    `static_sold_out`              TINYINT(1)   NOT NULL DEFAULT 0,
    `bundle_sales_available_count` INT          NOT NULL DEFAULT 0,
    `bundle_sales_total_count`     INT          NOT NULL DEFAULT 0,
    `created_time`                 DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_time`                 DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_bundle_id` (`bundle_id`),
    KEY `idx_bundle_state` (`bundle_state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

#### 000013_create_bundle.down.sql

```sql
DROP TABLE IF EXISTS `bundle`;
```

#### 000016_add_bundle_credit.up.sql（credit + time_span/time_unit 替代 monthly_tokens）

```sql
-- 新增 credit 列
ALTER TABLE `bundle` ADD COLUMN `credit` BIGINT NOT NULL DEFAULT 0 AFTER `agent_quota`;

-- 新增套餐周期字段
ALTER TABLE `bundle` ADD COLUMN `time_span` INT NOT NULL DEFAULT 1 AFTER `credit`;
ALTER TABLE `bundle` ADD COLUMN `time_unit` VARCHAR(2) NOT NULL DEFAULT 'm' AFTER `time_span`;

-- 删除废弃的 monthly_tokens 列
ALTER TABLE `bundle` DROP COLUMN `monthly_tokens`;
```

#### 000016_add_bundle_credit.down.sql

```sql
ALTER TABLE `bundle` ADD COLUMN `monthly_tokens` BIGINT NOT NULL DEFAULT 0 AFTER `ai_gateway_plan_id`;
ALTER TABLE `bundle` DROP COLUMN `time_unit`;
ALTER TABLE `bundle` DROP COLUMN `time_span`;
ALTER TABLE `bundle` DROP COLUMN `credit`;
```

> **迁移说明**：
> - 历史数据处理：000016 执行前如果 `monthly_tokens` 有业务数据，运营需先手动回填 `credit`（新增列默认 0）。本项目 bundle 表目前仅 `bundle_trial_001` 一条种子数据，可通过重新 ImportBundle 覆盖。
> - ai-gateway 侧 Plan 的 `monthly_tokens` 字段保持不变（那是 ai-gateway 自己的字段，不受影响）。

---

## 4. 代码层设计

### 4.1 Model 层

遵循项目既有 Model 设计模式（`BaseEntity` + `BaseDao` + `DaoFactory`）：

#### 目录结构

```
ctl/pkg/model/
├── bundle/
│   ├── entity.go          # Bundle Entity 定义 + 常量
│   └── dao.go             # Bundle DAO 接口 + 实现
```

#### Bundle Entity

```go
package bundle

import "ctl/pkg/model"

const (
    TableName = "bundle"

    ColumnBundleID                = "bundle_id"
    ColumnBundleName              = "bundle_name"
    ColumnDescription             = "description"
    ColumnBundleState             = "bundle_state"
    ColumnAgentQuota              = "agent_quota"
    ColumnCredit                  = "credit"
    ColumnTimeSpan                = "time_span"
    ColumnTimeUnit                = "time_unit"
    ColumnAiGatewayPlanID         = "ai_gateway_plan_id"
    ColumnStaticSoldOut           = "static_sold_out"
    ColumnBundleSalesAvailCount   = "bundle_sales_available_count"
    ColumnBundleSalesTotalCount   = "bundle_sales_total_count"

    StateOnline  = "ONLINE"
    StateOffline = "OFFLINE"

    SalesStateAvailable = "AVAILABLE"
    SalesStateSoldOut   = "SOLD_OUT"

    TimeUnitMonth = "m"
    TimeUnitDay   = "d"
)

// DescriptionItem description JSON 中的单个 KV 条目
type DescriptionItem struct {
    Key   string `json:"Key"`
    Value string `json:"Value"`
}

type Entity struct {
    model.BaseEntity

    BundleID               string `gorm:"column:bundle_id;uniqueIndex:uk_bundle_id"`
    BundleName             string `gorm:"column:bundle_name"`
    Description            string `gorm:"column:description;type:text"` // JSON: [{"Key":"...","Value":"..."}]
    BundleState            string `gorm:"column:bundle_state;index:idx_bundle_state"`
    AgentQuota             int64  `gorm:"column:agent_quota"`
    Credit                 int64  `gorm:"column:credit"`                 // 用户可见积分额度（对应 credit × ratio 个 Token）
    TimeSpan               int    `gorm:"column:time_span"`              // 套餐周期数值
    TimeUnit               string `gorm:"column:time_unit"`              // 套餐周期单位 "m" / "d"
    AiGatewayPlanID        string `gorm:"column:ai_gateway_plan_id"`     // 关联 ai-gateway Plan UUID，credit=0 时允许为空
    StaticSoldOut          bool   `gorm:"column:static_sold_out"`
    BundleSalesAvailCount  int    `gorm:"column:bundle_sales_available_count"`
    BundleSalesTotalCount  int    `gorm:"column:bundle_sales_total_count"`
}

func (Entity) TableName() string {
    return TableName
}

// SalesState 计算售卖状态：static_sold_out=true 或 available_count=0 时返回 SOLD_OUT
func (e *Entity) SalesState() string {
    if e.StaticSoldOut || e.BundleSalesAvailCount <= 0 {
        return SalesStateSoldOut
    }
    return SalesStateAvailable
}
```

### 4.2 DAO 层

```go
type Dao interface {
    model.Dao

    GetByBundleID(bundleID string) (*Entity, error)
    ListAll() ([]*Entity, error)
    ListByState(state string) ([]*Entity, error)
    // Upsert 不存在则创建，存在则覆盖性更新全部字段
    Upsert(entity *Entity) error
    // UpdateByBundleIDs 批量部分更新，对指定 bundle_id 列表统一更新 updates 中的字段
    UpdateByBundleIDs(bundleIDs []string, updates map[string]interface{}) (int64, error)

    // DecrementAvailCount 原子扣减可售卖余量（WHERE available_count >= cnt），返回是否扣减成功
    // 用于 Pass 创建时占用一个售卖名额
    DecrementAvailCount(bundleID string, cnt int) (bool, error)
    // IncrementAvailCount 原子回滚可售卖余量
    // 用于 Pass 创建失败时回滚扣减
    IncrementAvailCount(bundleID string, cnt int) error
    // RefreshAllAvailCount 将所有 ONLINE 套餐的 available_count 刷新为 total_count
    // 供每日定时任务调用，恢复每日售卖配额
    RefreshAllAvailCount() (int64, error)
}
```

> **设计说明**：
> - `ListAll` 执行 `db.Find(&entities)`，返回所有套餐记录，供后台管理的 `GetBundles` 使用。
> - `ListByState` 按状态筛选，供用户可见的 `DescribeBundles` 使用。
> - `UpdateByBundleIDs` 执行 `db.Model(&Entity{}).Where("bundle_id IN ?", bundleIDs).Updates(updates)`，返回实际影响行数。Logic 层通过比较影响行数与传入 ID 数量来判断是否有不存在的 bundle。后续新增可修改字段时，DAO 层无需改动。
> - `DecrementAvailCount` 使用 `UPDATE ... WHERE bundle_id = ? AND available_count >= ?` 语句，单行原子操作天然并发安全，无需加锁。
> - `IncrementAvailCount` 用于配合 `DecrementAvailCount`，在 Pass 创建失败时回滚已扣减的余量。
> - `RefreshAllAvailCount` 批量 `UPDATE bundle SET available_count = total_count WHERE bundle_state = 'ONLINE'`。

### 4.3 Logic 层

```
ctl/pkg/logic/bundle/
├── logic.go               # Bundle 业务逻辑
└── cron.go                # 每日定时刷新 available_count 的后台任务
```

#### Bundle Logic 接口

```go
type Logic interface {
    // === 后台管理接口（admin-gateway） ===

    // ImportBundle 导入套餐：不存在则创建，存在则覆盖性更新
    // 内部执行强校验（见 4.7.1.1）：
    //   - credit == 0 → ai_gateway_plan_id 必须为空
    //   - credit > 0  → ai_gateway_plan_id 必须非空，且需调 ai-gateway 校验：
    //     Plan.monthly_tokens == credit × credit_token_ratio
    //     Plan.period_value   == time_span
    //     Plan.period_unit 与 time_unit 映射一致（"m" ↔ "months" / "d" ↔ "days"）
    ImportBundle(bundleID string, bundleName string, description string, agentQuota int64,
        credit int64, timeSpan int, timeUnit string, aiGatewayPlanID string,
        staticSoldOut bool, salesAvailCount int, salesTotalCount int) error

    // GetBundles 查询所有套餐（含 ONLINE 和 OFFLINE）
    GetBundles() ([]*BundleDetail, error)

    // ModifyBundles 批量修改：对 bundleIDs 列表统一应用相同的字段变更
    // 若同时传入 credit / time_span / time_unit / ai_gateway_plan_id 相关字段，
    // 需要重新跑一次 4.7.1.1 的映射校验
    ModifyBundles(bundleIDs []string, req *ModifyBundleFields) error

    // === 用户可见接口（CTL） ===

    // DescribeBundles 查询上线套餐（仅 ONLINE），返回中包含计算字段 bundle_sales_state
    DescribeBundles() ([]*BundleDetail, error)
}

// ModifyBundleFields 可修改字段，所有字段均为指针类型
// - nil 表示不修改该字段
// - 非 nil 表示更新为指针指向的值
// - 后续新增可修改字段，只需在此结构体中添加对应指针字段
type ModifyBundleFields struct {
    BundleName         *string `json:"bundle_name,omitempty"`
    Description        *string `json:"description,omitempty"` // JSON: [{"Key":"...","Value":"..."}]
    BundleState        *string `json:"bundle_state,omitempty"`
    AgentQuota         *int64  `json:"agent_quota,omitempty"`
    Credit             *int64  `json:"credit,omitempty"`               // 用户可见积分额度
    TimeSpan           *int    `json:"time_span,omitempty"`            // 套餐周期数值
    TimeUnit           *string `json:"time_unit,omitempty"`            // 套餐周期单位 "m"/"d"
    AiGatewayPlanID    *string `json:"ai_gateway_plan_id,omitempty"`
    StaticSoldOut      *bool   `json:"static_sold_out,omitempty"`
    SalesAvailCount    *int    `json:"bundle_sales_available_count,omitempty"`
    SalesTotalCount    *int    `json:"bundle_sales_total_count,omitempty"`
}

type BundleDetail struct {
    BundleID               string
    BundleName             string
    Description            string // JSON: [{"Key":"...","Value":"..."}]
    BundleState            string
    AgentQuota             int64
    Credit                 int64  // 用户可见积分额度
    TimeSpan               int    // 套餐周期数值
    TimeUnit               string // 套餐周期单位 "m"/"d"
    AiGatewayPlanID        string // ai-gateway Plan UUID（credit=0 时允许空）
    StaticSoldOut          bool
    BundleSalesAvailCount  int
    BundleSalesTotalCount  int
    BundleSalesState       string // 计算字段：AVAILABLE / SOLD_OUT
    CreatedTime            time.Time
    UpdatedTime            time.Time
}
```

> **设计说明**：
>
> `BundleSalesState` 是**计算字段**，不存储在 DB 中。Logic 层在构造 `BundleDetail` 时根据以下规则计算：
> ```
> if static_sold_out == true || bundle_sales_available_count <= 0:
>     bundle_sales_state = "SOLD_OUT"
> else:
>     bundle_sales_state = "AVAILABLE"
> ```
>
> `DescribeBundles` 和 `GetBundles` 均返回此计算字段，使调用方无需自行判断售卖状态。

> **设计说明**：`ModifyBundles` 实现逻辑：
> 1. 校验 `bundleIDs` 非空、`ModifyBundleFields` 至少有一个非 nil 字段
> 2. 校验字段合法性（如 `BundleState` 必须是 `ONLINE` / `OFFLINE`，`AgentQuota` ≥ 0，`MonthlyTokens` ≥ 0（预留），`SalesAvailCount` ≥ 0，`SalesTotalCount` ≥ 0）
> 3. 构造 `map[string]interface{}` 仅包含需要更新的列
> 4. 调用 `dao.UpdateByBundleIDs(bundleIDs, updates)`
> 5. 比较影响行数与 `len(bundleIDs)`，不一致则返回错误
>
> 单条修改是批量的特例（`bundleIDs` 长度为 1）。

### 4.4 错误码

```
ctl/pkg/errcode/bundle.go
```

```go
package errcode

var (
    ErrBundleNotFound        = Register(New("BUNDLE_NOT_FOUND", 404, "bundle not found"))
    ErrBundleStateInvalid    = Register(New("BUNDLE_STATE_INVALID", 400, "invalid bundle state"))
    ErrBundleConfigInvalid   = Register(New("BUNDLE_CONFIG_INVALID", 400, "invalid bundle config"))
    ErrBundleNoFieldToUpdate = Register(New("BUNDLE_NO_FIELD_TO_UPDATE", 400, "no field to update"))
    ErrBundleIDsEmpty        = Register(New("BUNDLE_IDS_EMPTY", 400, "bundle_ids cannot be empty"))
    ErrBundlePartialNotFound = Register(New("BUNDLE_PARTIAL_NOT_FOUND", 400, "some bundle_ids not found"))
    // ErrBundleSalesQuotaEmpty Pass 创建时 bundle 可售卖余量为 0
    ErrBundleSalesQuotaEmpty = Register(New("BUNDLE_SALES_QUOTA_EMPTY", 400, "bundle sales quota is exhausted"))
    // ImportBundle / ModifyBundles 时 plan ↔ credit ↔ period 校验错误码
    ErrBundlePlanMismatch          = Register(New("BUNDLE_PLAN_MISMATCH", 400, "ai_gateway_plan_id must be empty when credit=0, and non-empty when credit>0"))
    ErrBundlePlanNotFound          = Register(New("BUNDLE_PLAN_NOT_FOUND", 400, "ai-gateway plan not found"))
    ErrBundleCreditTokenMismatch   = Register(New("BUNDLE_CREDIT_TOKEN_MISMATCH", 400, "plan.monthly_tokens does not match credit × ratio"))
    ErrBundlePeriodMismatch        = Register(New("BUNDLE_PERIOD_MISMATCH", 400, "plan.period does not match bundle.time_span/time_unit"))
    ErrBundleAiGatewayUnavailable  = Register(New("BUNDLE_AIGATEWAY_UNAVAILABLE", 502, "ai-gateway unavailable, cannot validate plan"))
)
```

### 4.5 DaoFactory 注册

在 `ctl/pkg/model/factory/factory.go` 中注册新的 DAO：

```go
import (
    bundleModel "ctl/pkg/model/bundle"
)

// 在 Init() 中添加：
BundleDao = bundleModel.NewDao()
```

### 4.5.1 Credit 全局配置（server_conf.toml）

credit↔token 转换比例通过全局配置统一管理：

```toml
# ctl/conf/*/common/server_conf.toml
[bundle]
# credit 与 ai-gateway Token 的转换比例
# 1 credit = credit_token_ratio tokens
# 默认 10000：即 1 积分 = 10000 Token
credit_token_ratio = 10000
```

对应 Go 配置结构：

```go
// ctl/pkg/config/define.go
type BundleConfig struct {
    CreditTokenRatio int64 `toml:"credit_token_ratio"` // credit 到 token 的转换倍数
}

// ServerConfig 中新增字段
Bundle *BundleConfig `toml:"bundle"`
```

**换算工具函数**（放在 `ctl/pkg/logic/bundle/credit.go`）：

```go
// CreditToTokens 将 credit 转为 token
func CreditToTokens(credit int64) int64 {
    ratio := config.ServerConf.Bundle.CreditTokenRatio
    if ratio <= 0 {
        ratio = 10000 // 默认值防御
    }
    return credit * ratio
}

// TokensToCredit 将 token 转为 credit（向下取整）
func TokensToCredit(tokens int64) int64 {
    ratio := config.ServerConf.Bundle.CreditTokenRatio
    if ratio <= 0 {
        ratio = 10000
    }
    return tokens / ratio
}
```

### 4.6 售卖配额（available_count）联动机制

Bundle 的 `bundle_sales_available_count` 字段用于控制每日售卖名额。该字段涉及三个运行时入口：

#### 4.6.1 Pass 创建时：原子扣减 + 失败回滚

`ctl/pkg/logic/pass/logic.go` 的 `CreateTrialPass` 流程：

```
步骤 1: 校验 Bundle 存在且 ONLINE
步骤 2: 静态售罄校验（static_sold_out）
步骤 3: 原子扣减 available_count（DecrementAvailCount）
         ├── 成功：继续
         └── 失败：返回 ErrBundleSalesQuotaEmpty
       defer: 若后续步骤失败 → 自动 IncrementAvailCount 回滚 +1
步骤 4: 用户唯一 Pass 校验
步骤 5: 配额校验（user_resource_quota）
步骤 6: 生成 pass_id，计算 expired_time
步骤 7: 事务写入 pass + 更新 user_resource_quota
         └── 成功：取消 defer 的回滚
步骤 8: 返回 PassDetail
```

**并发安全**：`DecrementAvailCount` 使用 `UPDATE bundle SET available_count = available_count - 1 WHERE bundle_id = ? AND available_count >= 1`，单行条件更新天然原子，无需显式加锁。

**回滚策略**：使用 defer + 布尔标志。任意后续步骤失败（用户已有 pass、配额不足、ID 生成失败、事务写入失败等）都会触发回滚；只有最终成功才将标志置 false 跳过回滚。

#### 4.6.2 每日定时刷新：CTL 内置定时任务

`ctl/pkg/logic/bundle/cron.go` 提供 `StartDailyAvailCountRefresh`，在 CTL API `run()` 启动时注册：

```go
// ctl/main/api/server.go
bundlelogic.StartDailyAvailCountRefresh(resource.ZapLogger, 10, cronDone) // 每天 10:00 (UTC+8)
```

**触发时间**：每天 UTC+8 时区 10:00 整  
**执行动作**：`UPDATE bundle SET bundle_sales_available_count = bundle_sales_total_count WHERE bundle_state = 'ONLINE'`  
**优雅关闭**：通过 `cronDone` channel 与 HTTP Server 的 shutdown 流程联动

**为什么放在 CTL 进程内而不是独立的 cron 服务**：
- Bundle 表由 CTL 独家写入，放在 CTL 进程内无跨服务依赖
- 单副本部署下一次执行即可覆盖全部 ONLINE 套餐；多副本部署下每副本独立执行 `UPDATE ... SET = total_count` 结果一致（幂等）
- 避免引入额外的调度基础设施

#### 4.6.3 运营手动重置（可选）

通过 `PUT /admin/api/ctl/bundles` 的 `bundle_sales_available_count` 字段可在任意时刻手动重置某个套餐的可售卖余量（例如新上线套餐、临时加配额等场景）。

### 4.7 Credit 与 ai-gateway Plan 订阅联动

Bundle 引入 `credit` + `time_span` + `time_unit` 字段后，CTL 与 ai-gateway 之间建立以下联动契约：

#### 4.7.1 运营侧约束

- 运营在 ai-gateway 侧先行创建/维护 Plan；Plan 的 `monthly_tokens`、`period_value`、`period_unit` 应与 Bundle 对应字段匹配
- `ImportBundle` 时将该 Plan 的 UUID 填入 `bundle.ai_gateway_plan_id`
- CTL **不主动**在 ai-gateway 创建或修改 Plan，但会在 ImportBundle 时**主动校验**一致性（见 4.7.1.1）
- Bundle 的 `time_span` + `time_unit` 直接决定 **Pass 的有效期**；同时必须与 Plan 的 `period_value`/`period_unit` 对齐，保证 Pass 到期时间与 Subscription 到期时间一致

#### 4.7.1.1 ImportBundle 强一致性校验

**`ImportBundle` / `ModifyBundles` 在写入 DB 前执行以下校验规则**，任一不满足直接返回错误、拒绝写入：

##### 规则 1：time_unit 取值合法

```
time_unit ∈ {"m", "d"}
time_span > 0
```

不合法返回 `ErrBundleConfigInvalid`。

##### 规则 2：credit == 0 时

```
ai_gateway_plan_id 必须为空字符串
```

- 语义：无 AI Token 权益的套餐（例如赠送型、agent_quota-only 套餐）
- 若 `credit == 0` 但 `ai_gateway_plan_id != ""`：返回 `ErrBundlePlanMismatch`

##### 规则 3：credit > 0 时

```
ai_gateway_plan_id 必须非空
```

并且 CTL 需向 ai-gateway 查询该 Plan（`GET /api/internal/plans/:id`），校验以下三项：

| Plan 字段 | 必须等于 | 不满足返回 |
|-----------|----------|-----------|
| `monthly_tokens` | `credit × config.credit_token_ratio` | `ErrBundleCreditTokenMismatch` |
| `period_value`   | `time_span` | `ErrBundlePeriodMismatch` |
| `period_unit`    | `"m"` → `"months"`，`"d"` → `"days"` | `ErrBundlePeriodMismatch` |

若 Plan 不存在（404）：返回 `ErrBundlePlanNotFound`。  
若 ai-gateway 不可达：返回 `ErrBundleAiGatewayUnavailable`。

##### 校验伪代码

```go
func validateBundleConfig(b *Entity) error {
    // 规则 1
    if b.TimeUnit != "m" && b.TimeUnit != "d" {
        return ErrBundleConfigInvalid
    }
    if b.TimeSpan <= 0 {
        return ErrBundleConfigInvalid
    }
    // 规则 2
    if b.Credit == 0 {
        if b.AiGatewayPlanID != "" {
            return ErrBundlePlanMismatch
        }
        return nil
    }
    // 规则 3 (credit > 0)
    if b.AiGatewayPlanID == "" {
        return ErrBundlePlanMismatch
    }
    plan, err := aigatewayAdapter.GetPlan(b.AiGatewayPlanID)
    if err != nil {
        return err // ErrBundlePlanNotFound / ErrBundleAiGatewayUnavailable
    }
    expectedTokens := b.Credit * config.CreditTokenRatio
    if plan.MonthlyTokens != expectedTokens {
        return ErrBundleCreditTokenMismatch
    }
    if plan.PeriodValue != b.TimeSpan {
        return ErrBundlePeriodMismatch
    }
    expectedUnit := map[string]string{"m": "months", "d": "days"}[b.TimeUnit]
    if plan.PeriodUnit != expectedUnit {
        return ErrBundlePeriodMismatch
    }
    return nil
}
```

##### 档位示例

| 档位 | credit | time_span / time_unit | Plan.monthly_tokens | Plan.period_value / period_unit | 合法？ |
|------|--------|-----------------------|---------------------|---------------------------------|-------|
| 试用 7 天（无 Token）      | 0    | 7 / d | —                       | —                             | ✅ |
| 月卡 100 积分              | 100  | 1 / m | 100 × 10000 = 1,000,000 | 1 / months                    | ✅ |
| 季卡 300 积分              | 300  | 3 / m | 300 × 10000 = 3,000,000 | 3 / months                    | ✅ |
| 年卡 1200 积分             | 1200 | 12 / m | 12,000,000             | 12 / months                   | ✅ |
| credit 与 Plan monthly_tokens 不匹配 | 100  | 1 / m | 500,000             | 1 / months                    | ❌ `ErrBundleCreditTokenMismatch` |
| 周期与 Plan 不匹配          | 100  | 1 / m | 1,000,000              | 3 / months                    | ❌ `ErrBundlePeriodMismatch` |
| credit=0 却关联 Plan       | 0    | 7 / d | —                       | —                             | ❌ `ErrBundlePlanMismatch` |

#### 4.7.2 创建 Pass 时的订阅开通（严格一致）

`CreateTrialPass` 流程中 Pass 有效期由 CTL 基于 Bundle 的 `time_span` + `time_unit` 自行计算；订阅调用同步触发，失败则整体回滚：

```
步骤 7.1 (CTL 计算): expired_time = CalcExpiredTime(now, bundle.time_span, bundle.time_unit)
        time_unit="m" → 按自然月累加（月末溢出处理）
        time_unit="d" → 按自然天累加

步骤 7.2 (订阅联动，仅当 credit > 0):
        调用 ai-gateway POST /internal/subscriptions/apply
        Request: { user_id, plan_id: bundle.ai_gateway_plan_id }
        Response: { subscription_id, period_end, token_balance, ... }
        
        成功 → 继续（CTL 侧 expired_time 与 ai-gateway period_end 因 ImportBundle 已校验一致，
                无需再读响应覆盖）
        失败 → 返回错误，触发 defer 回滚 bundle.available_count
                （pass 尚未写入，无需补偿删除）

步骤 7.3 (credit == 0 时): 跳过订阅联动

步骤 8: 事务写入 pass + user_resource_quota
```

**关键点**：
- **Pass.expired_time 由 CTL 计算**（不再依赖 ai-gateway 返回的 period_end）
- Plan 的 period 与 Bundle 的 time_span/time_unit 已在 ImportBundle 校验一致，两侧时间自然对齐
- 订阅失败前 pass 尚未落库，回滚成本最低（仅 +1 bundle avail_count）

**CalcExpiredTime 实现**（`ctl/pkg/logic/pass/logic.go` 内）：

```go
func CalcExpiredTime(start time.Time, timeSpan int, timeUnit string) (time.Time, error) {
    switch timeUnit {
    case "m":
        return addMonthsNatural(start, timeSpan), nil   // 自然月（月末溢出处理）
    case "d":
        return start.AddDate(0, 0, timeSpan), nil
    default:
        return time.Time{}, fmt.Errorf("invalid time_unit: %s", timeUnit)
    }
}
```

> **一致性策略**：采用"严格一致"而非"最终一致"。订阅失败直接让整个 pass 创建失败；避免出现"pass 创建成功但用户没 Token 额度"的用户可见不一致状态。

#### 4.7.3 查询用户 Pass 时的 credit 换算（实时）

`DescribePasses` 流程在返回 pass 前新增跨服务调用：

```
对每个 pass:
    若 bundle.ai_gateway_plan_id 非空:
        调用 ai-gateway GET /internal/subscriptions/active?user_id=xxx
        Response: { plan_id, token_balance, monthly_tokens, ... }
        
        计算返回：
        - credit_total     = bundle.credit
        - credit_available = TokensToCredit(token_balance)
    否则:
        credit_total = 0
        credit_available = 0
```

> **为什么选择实时查询**：Token 余额变化频繁（每次 LLM 调用都在扣减）。冗余存储难以保证一致性；实时查询虽有跨服务开销，但语义清晰且避免数据漂移。

#### 4.7.4 换算的职责分工

| 维度 | 单位 | 归属 | 用户可见 |
|------|------|------|---------|
| `credit` | 积分 | CTL | ✅ 可见 |
| `token_balance` | Token | ai-gateway | ❌ 不可见 |
| `monthly_tokens` | Token | ai-gateway Plan | ❌ 不可见 |

所有对外（用户可见接口）展示只使用 `credit`；所有跨服务内部通信（CTL ↔ ai-gateway）只使用 `token`。CTL 负责在边界处做 credit↔token 换算。

---

## 5. 与现有配额系统的关系

### 5.1 当前配额体系

```
user_resource_quota 表
  ├── user_id
  ├── resource_name = "OPENCLAW_INSTANCE"
  ├── resource_key  = ""
  ├── resource_quota_available  (可用配额)
  └── resource_quota_total      (总配额, 由 bundle.agent_quota 主导)
```

> **2026-06-08 更新**：`OPENCLAW_INSTANCE` 全局默认值（`server_conf.toml -> [global_quota.resource_default_quotas].OPENCLAW_INSTANCE = 5`）已**退化为防御性兜底**：
>
> - **正常付费链路**：用户购买 bundle 后，`modelpass.CreatePassWithQuota` 在同一事务内按 `bundle.agent_quota` 直接覆盖 `user_resource_quota.resource_quota_total`，**完全不经过默认 5 的兜底路径**
> - **`CreateInstance` 强校验**：bundle 引入后，`CreateInstance` 入口已强校验「用户必须存在 active pass」（无 active pass → `INSTANCE_NO_ACTIVE_PASS` 403），杜绝了「无 pass 用户白嫖默认 5 配额」的旧路径
> - **`ensureDefaultQuota` 当前语义**：仅作 last-resort 兜底，处理「active pass 存在但 quota 行被外力（运维 SQL / 数据迁移异常）删除」的极端场景；INSERT ON CONFLICT DO NOTHING 幂等，对正常路径无副作用

### 5.2 Bundle 引入后的演进方向

当前阶段（本次需求）：
- Bundle 作为**套餐定义**存在，包含 Agent 配额 + Credit 积分两个权益维度
- `agent_quota` 管理 Agent 创建配额（CTL 侧）
- `credit` 管理用户可见的积分额度，通过 `credit_token_ratio` 映射到 ai-gateway Token
- `ai_gateway_plan_id` 关联 ai-gateway Plan；可选字段，为空时跳过 Token 订阅开通
- 引入 Pass 作为用户权益实例，创建 Pass 时联动开通 ai-gateway Subscription

后续阶段（未来需求）：
- 新增 `pass`（用户权益）表，记录用户持有的套餐权益实例 ✅ 已实现
- 用户购买 Bundle 后，创建 Pass 记录：
  - 根据 `bundle.agent_quota` 更新 `user_resource_quota.resource_quota_total` ✅ 已实现
  - 若 `bundle.ai_gateway_plan_id` 非空，调用 ai-gateway `ApplySubscription` 开通 Token 订阅（credit 映射到 Plan 的 monthly_tokens）
- 支持套餐到期、续费、升降级等场景（规划中）
- 如需多维度权益，通过 `ALTER TABLE ADD COLUMN` 扩展 bundle 表

远期阶段（未来演进）：
- 多模型定价分层：通过 ai-gateway Plan 的 `TokenMultipliers` 对不同模型按不同倍率扣 Token
- 套餐续费、升降级的 credit 结转策略（保留/作废/折算）
- credit 消耗日志与账单展示

### 5.3 演进路线图

```
当前阶段 (v2)                                远期阶段 (v3)
┌──────────────────┐                         ┌──────────────────┐
│     bundle       │                         │     bundle       │
│ (含权益配置)      │                         │ (含权益配置)      │
│ agent_quota      │                         │ agent_quota      │
│ credit           │ ← 已启用                │ credit           │ ← 已启用
│ ai_gw_plan_id    │ ← 已启用（可选）         │ ai_gw_plan_id    │ ← 已启用
└────────┬─────────┘                         └────────┬─────────┘
         │                                            │
  ┌──────▼──────┐                            ┌───────▼────────┐
  │    pass     │ ← 用户权益实例              │     pass       │
  └──┬───────┬──┘                            └──┬────────┬────┘
     │       │                                  │        │
┌────▼───┐ ┌─▼──────────────┐              ┌───▼────┐ ┌─▼──────────────┐
│ user_  │ │  ai-gateway    │              │ user_  │ │  ai-gateway    │
│ resource│ │  Subscription  │              │resource│ │  Subscription  │
│ _quota  │ │  (Token 订阅)  │              │_quota  │ │ + 升降级/续费   │
└────────┘ └────────────────┘              └────────┘ └────────────────┘
Agent 配额联动  Credit↔Token 联动            Agent 配额联动  多模型分层计费
```

---

## 6. API 设计

Bundle API 采用**两层架构**：

- **admin-gateway（后台管理）**：面向内部运营人员，提供套餐的导入、查询全量、批量修改能力。经由 `admin-gateway` 反向代理到 CTL 的 `/admin/api/ctl/bundles` 前缀路径。
- **CTL（用户可见）**：面向终端用户，仅提供查询上线套餐的只读能力。直接由 CTL 承载在 `/v1/bundles` 路径。

```
┌──────────────┐  POST/GET/PUT /admin/api/ctl/bundles   ┌──────────┐
│ admin-gateway│ ──────────────────────────────────────► │   CTL    │
│ (运营后台)    │        HTTP Basic Auth                  │ (控制面)  │
└──────────────┘                                         │          │
                                                         │          │
┌──────────────┐  GET /v1/bundles                        │          │
│  用户客户端   │ ──────────────────────────────────────► │          │
└──────────────┘                                         └──────────┘
```

### 6.1 后台管理接口（admin-gateway → CTL）

经由 `admin-gateway` 代理，实际请求打到 CTL 的 `/admin/api/ctl/bundles` 路径。

| 方法 | 路径 | 说明 | 对应 Logic |
|------|------|------|-----------|
| `POST` | `/admin/api/ctl/bundles` | 导入套餐（不存在则创建，存在则覆盖） | `ImportBundle` |
| `GET`  | `/admin/api/ctl/bundles` | 查询所有套餐（含 ONLINE + OFFLINE） | `GetBundles` |
| `PUT`  | `/admin/api/ctl/bundles` | 批量修改套餐（partial update，传哪个字段改哪个） | `ModifyBundles` |

### 6.2 用户可见接口（CTL）

由 CTL 直接承载，仅返回上线（ONLINE）状态的套餐。

| 方法 | 路径 | 说明 | 对应 Logic |
|------|------|------|-----------|
| `GET` | `/v1/bundles` | 查询上线套餐（仅 ONLINE） | `DescribeBundles` |

### 6.3 请求/响应示例

#### 导入套餐（ImportBundle） — 后台管理

```json
// POST /admin/api/ctl/bundles
// 不存在则创建，存在则覆盖性更新
// Request
{
    "bundle_id": "free-trial",
    "bundle_name": "体验版",
    "description": [{"Key": "体验Agent", "Value": "至多1个"}, {"Key": "积分", "Value": "10 credit/月"}],
    "agent_quota": 1,
    "credit": 10,
    "time_span": 1,
    "time_unit": "m",
    "ai_gateway_plan_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "static_sold_out": false,
    "bundle_sales_available_count": 100,
    "bundle_sales_total_count": 100
}

// Response 200 (新建或覆盖均返回完整状态)
{
    "bundle_id": "free-trial",
    "bundle_name": "体验版",
    "description": [{"Key": "体验Agent", "Value": "至多1个"}, {"Key": "积分", "Value": "10 credit/月"}],
    "bundle_state": "OFFLINE",
    "agent_quota": 1,
    "credit": 10,
    "time_span": 1,
    "time_unit": "m",
    "ai_gateway_plan_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "static_sold_out": false,
    "bundle_sales_available_count": 100,
    "bundle_sales_total_count": 100,
    "bundle_sales_state": "AVAILABLE",
    "created_time": "2026-04-17T12:00:00Z",
    "updated_time": "2026-04-17T12:00:00Z"
}
```

#### 查询所有套餐（GetBundles） — 后台管理

```json
// GET /admin/api/ctl/bundles
// 返回所有套餐（含 ONLINE 和 OFFLINE）
// Response 200
{
    "bundles": [
        {
            "bundle_id": "free-trial",
            "bundle_name": "体验版",
            "description": [{"Key": "体验Agent", "Value": "至多1个"}, {"Key": "积分", "Value": "10 credit/月"}],
            "bundle_state": "OFFLINE",
            "agent_quota": 1,
            "credit": 10,
            "time_span": 1,
            "time_unit": "m",
            "ai_gateway_plan_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            "static_sold_out": true,
            "bundle_sales_available_count": 0,
            "bundle_sales_total_count": 100,
            "bundle_sales_state": "SOLD_OUT",
            "created_time": "2026-04-17T12:00:00Z",
            "updated_time": "2026-04-17T12:00:00Z"
        },
        {
            "bundle_id": "basic-5",
            "bundle_name": "基础版",
            "description": [{"Key": "Agent配额", "Value": "至多5个"}, {"Key": "积分", "Value": "100 credit/月"}],
            "bundle_state": "ONLINE",
            "agent_quota": 5,
            "credit": 100,
            "time_span": 1,
            "time_unit": "m",
            "ai_gateway_plan_id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
            "static_sold_out": false,
            "bundle_sales_available_count": 50,
            "bundle_sales_total_count": 100,
            "bundle_sales_state": "AVAILABLE",
            "created_time": "2026-04-17T11:00:00Z",
            "updated_time": "2026-04-17T12:30:00Z"
        }
    ]
}
```

#### 批量修改套餐（ModifyBundles） — 后台管理

```json
// PUT /admin/api/ctl/bundles
// 示例 1：批量上线多个套餐
// Request
{
    "bundle_ids": ["free-trial", "basic-5", "pro-20"],
    "bundle_state": "ONLINE"
}

// Response 200
{
    "affected_count": 3
}
```

```json
// PUT /admin/api/ctl/bundles
// 示例 2：修改单个套餐的配额（单条是批量的特例）
// Request
{
    "bundle_ids": ["free-trial"],
    "agent_quota": 10
}

// Response 200
{
    "affected_count": 1
}
```

```json
// PUT /admin/api/ctl/bundles
// 示例 3：批量修改状态和配额
// Request
{
    "bundle_ids": ["basic-5", "pro-20"],
    "bundle_state": "OFFLINE",
    "agent_quota": 0
}

// Response 200
{
    "affected_count": 2
}
```

```json
// PUT /admin/api/ctl/bundles
// 示例 4：设置静态售罄
// Request
{
    "bundle_ids": ["free-trial"],
    "static_sold_out": true
}

// Response 200
{
    "affected_count": 1
}
```

```json
// PUT /admin/api/ctl/bundles
// 示例 5：重置每日可售卖量
// Request
{
    "bundle_ids": ["basic-5"],
    "bundle_sales_available_count": 100,
    "bundle_sales_total_count": 100
}

// Response 200
{
    "affected_count": 1
}
```

#### 查询上线套餐（DescribeBundles） — 用户可见

```json
// GET /v1/bundles
// 仅返回 ONLINE 状态的套餐
// Response 200
{
    "bundles": [
        {
            "bundle_id": "basic-5",
            "bundle_name": "基础版",
            "description": [{"Key": "Agent配额", "Value": "至多5个"}, {"Key": "积分", "Value": "100 credit/月"}],
            "bundle_state": "ONLINE",
            "agent_quota": 5,
            "credit": 100,
            "time_span": 1,
            "time_unit": "m",
            "bundle_sales_available_count": 50,
            "bundle_sales_total_count": 100,
            "bundle_sales_state": "AVAILABLE",
            "created_time": "2026-04-17T11:00:00Z",
            "updated_time": "2026-04-17T12:30:00Z"
        }
    ]
}
```

> **注**：`DescribeBundles` 用户可见接口**不返回** `static_sold_out`、`ai_gateway_plan_id` 字段。`static_sold_out` 为运营内部控制；`ai_gateway_plan_id` 为 CTL ↔ ai-gateway 内部关联；`credit` 作为用户可见积分额度正常返回。`static_sold_out` 的效果已反映在计算字段 `bundle_sales_state` 中。用户无法看到底层 Token 数量，只看 credit。

> **扩展说明**：bundle 表新增字段（如 `storage_quota` 等），只需：
> 1. `ModifyBundleFields` 加对应指针字段
> 2. Logic 层 `ModifyBundles` 加对应校验逻辑
> 3. API 请求体自动支持新字段，无需新增接口
>
> 已按此模式新增 `static_sold_out`、`bundle_sales_available_count`、`bundle_sales_total_count`、`credit` 字段。`ai_gateway_plan_id` 作为与 ai-gateway 的关联 UUID 存储在表结构中，创建 Pass 时触发订阅联动。

---

## 7. 测试要点

### 7.1 单元测试

| 测试项 | 验证内容 |
|--------|---------|
| ImportBundle 新建 | bundle_id 不存在时正常创建，默认 OFFLINE |
| ImportBundle 覆盖 | bundle_id 已存在时覆盖更新全部字段 |
| ModifyBundles 单条 | `bundle_ids` 长度为 1，传 `bundle_state` 仅更新状态 |
| ModifyBundles 多条 | `bundle_ids` 包含多个 ID，统一更新 `agent_quota`，全部生效 |
| ModifyBundles 多字段 | 同时传 `bundle_state` + `agent_quota`，两个字段都更新 |
| ModifyBundles 空 IDs | `bundle_ids` 为空，返回 `ErrBundleIDsEmpty` |
| ModifyBundles 无字段 | 所有可修改字段均为 nil，返回 `ErrBundleNoFieldToUpdate` |
| ModifyBundles 部分不存在 | 某些 `bundle_id` 不存在，返回 `ErrBundlePartialNotFound` |
| ModifyBundles 无效状态 | `bundle_state` 传非法值，返回 `ErrBundleStateInvalid` |
| ModifyBundles 设置静态售罄 | `static_sold_out` 设为 true，售卖状态变为 SOLD_OUT |
| ModifyBundles 重置可售量 | 修改 `bundle_sales_available_count` 和 `bundle_sales_total_count` |
| GetBundles 全量 | 返回所有状态的 Bundle（ONLINE + OFFLINE） |
| GetBundles 含 credit 字段 | 返回 `credit` 和 `ai_gateway_plan_id`（默认 0 / 空） |
| DescribeBundles 上线 | 仅返回 ONLINE 状态的 Bundle |
| DescribeBundles 不返回 static_sold_out | 用户可见接口不暴露 static_sold_out 字段 |
| DescribeBundles 不返回 ai_gateway_plan_id | 用户可见接口不暴露 ai_gateway_plan_id（CTL ↔ ai-gateway 内部关联） |
| DescribeBundles 返回 credit | 用户可见接口暴露 credit 字段作为积分展示 |
| agent_quota 边界 | 允许为 0、不允许为负数 |
| credit 边界 | 允许为 0（默认）、不允许为负数 |
| time_span 边界 | 必须 > 0；≤0 返回 `ErrBundleConfigInvalid` |
| time_unit 合法性 | 仅接受 `"m"` 或 `"d"`；其他值返回 `ErrBundleConfigInvalid` |
| ImportBundle 无 Token 套餐 | `credit=0 + ai_gateway_plan_id=""` → 成功 |
| ImportBundle credit=0 但带 Plan | `credit=0 + ai_gateway_plan_id="xxx"` → 返回 `ErrBundlePlanMismatch` |
| ImportBundle credit>0 但无 Plan | `credit=100 + ai_gateway_plan_id=""` → 返回 `ErrBundlePlanMismatch` |
| ImportBundle Plan 不存在 | ai-gateway 返回 404 → 返回 `ErrBundlePlanNotFound` |
| ImportBundle Plan token 不匹配 | `credit=100, ratio=10000`，Plan.monthly_tokens=500000 → 返回 `ErrBundleCreditTokenMismatch` |
| ImportBundle Plan 周期值不匹配 | `time_span=1`，Plan.period_value=3 → 返回 `ErrBundlePeriodMismatch` |
| ImportBundle Plan 周期单位不匹配 | `time_unit="m"`，Plan.period_unit="days" → 返回 `ErrBundlePeriodMismatch` |
| ImportBundle ai-gateway 不可达 | 网络错误 → 返回 `ErrBundleAiGatewayUnavailable`，不写入 DB |
| ImportBundle 完整合法 | credit=100, time_span=1, time_unit="m", Plan.monthly_tokens=1000000, period=1/months → 成功 |
| ModifyBundles 修改 credit | 同时传 `credit/plan` 或涉及 credit 改动时重新执行校验规则 |
| ModifyBundles 修改周期 | 同时传 `time_span/time_unit` 时重新执行校验规则（需保持与 Plan 对齐） |
| ModifyBundles 仅改 name | 不触发 Plan 校验（未涉及 credit/time/plan 字段） |
| SalesState 静态售罄 | `static_sold_out=true` 时 `bundle_sales_state=SOLD_OUT`，忽略 available_count |
| SalesState 动态售罄 | `static_sold_out=false` 且 `available_count=0` 时 `bundle_sales_state=SOLD_OUT` |
| SalesState 可售 | `static_sold_out=false` 且 `available_count>0` 时 `bundle_sales_state=AVAILABLE` |
| DecrementAvailCount 成功 | `available_count > 0` 时扣减 1，返回 true |
| DecrementAvailCount 失败 | `available_count = 0` 时不扣减，返回 false |
| IncrementAvailCount | 调用后 `available_count + 1` |
| RefreshAllAvailCount | ONLINE 套餐的 `available_count` 被刷新为 `total_count`；OFFLINE 套餐不受影响 |
| CreditToTokens 换算 | `credit=10, ratio=10000` → `tokens=100000` |
| TokensToCredit 换算 | `tokens=99999, ratio=10000` → `credit=9`（向下取整） |
| CreditTokenRatio 默认值 | 配置缺失时使用默认值 `10000`，不报错 |
| ImportBundle credit=0 | 允许 credit 为 0（赠送型套餐无 Token 权益） |
| ImportBundle credit 负数 | 返回 `ErrBundleConfigInvalid` |

### 7.2 集成测试

| 测试项 | 验证内容 |
|--------|---------|
| 完整生命周期 | 创建多个 → ModifyBundles 批量上线 → ModifyBundles 批量改配额 → ModifyBundles 批量下线 |
| 部分 ID 不存在 | 3 个 ID 中 1 个不存在，返回错误，全部未修改 |
| 并发导入相同 bundle_id | Upsert 幂等性，两次导入结果一致 |
| GetBundles 全量 | 后台管理接口返回所有状态的记录 |
| DescribeBundles 筛选 | 用户接口只返回 ONLINE 状态的记录 |
| admin-gateway 代理验证 | 通过 admin-gateway 的 `/admin/api/ctl/bundles` 路径调用管理接口，验证代理转发正确 |
| 权限隔离 | 用户接口 `/v1/bundles` 仅支持 GET，不暴露 POST/PUT 方法 |
| 静态售罄 → 用户可见 | 设置 `static_sold_out=true` 后，DescribeBundles 返回 `bundle_sales_state=SOLD_OUT` |
| 动态售罄 → 用户可见 | `available_count` 减至 0 后，DescribeBundles 返回 `bundle_sales_state=SOLD_OUT` |
| 运营重置可售量 | ModifyBundles 重置 `available_count` 后，售卖状态恢复为 `AVAILABLE` |
| Pass 创建 → 动态扣减 | 每次 `CreateTrialPass` 成功后 `available_count - 1` |
| Pass 创建 → 名额耗尽 | `available_count = 0` 时 `CreateTrialPass` 返回 `ErrBundleSalesQuotaEmpty` |
| Pass 创建失败 → 回滚 | 用户已有 pass 等后续步骤失败时，`available_count` 不变（回滚成功） |
| 定时任务触发 | 每天 10:00（UTC+8）执行 `RefreshAllAvailCount` 后所有 ONLINE 套餐的 `available_count` 恢复到 `total_count` |
| Bundle credit 展示 | `DescribeBundles` 返回套餐的 `credit` 字段，前端用于展示积分信息 |
| Pass 创建 → 开通 Subscription | 若 `bundle.ai_gateway_plan_id` 非空，CreateTrialPass 成功后 ai-gateway 侧有 active subscription |
| Pass 创建 → Subscription 失败回滚 | ai-gateway 返回错误时，pass 不创建 + bundle available_count 回滚 |
| Bundle 无 Plan 关联 | `ai_gateway_plan_id=''` 时 Pass 创建跳过订阅开通，pass 记录正常生成 |
| DescribePasses credit 换算 | 用户查询 pass 时返回 `credit_total` 和 `credit_available`（由 ai-gateway token_balance 换算） |

---

## 8. 影响评估

| 影响范围 | 影响程度 | 说明 |
|---------|---------|------|
| 数据库 | 新增 1 张表 + 新增 1 次迁移 | 000013 建表；000016 迁移（credit 替代 monthly_tokens） |
| CTL Model 层 | 新增 1 个 model 包 | 不修改现有 model |
| CTL Logic 层 | 新增 1 个 logic 包 | 不修改现有 logic |
| CTL API 层 | 新增管理接口 + 用户接口 | 管理接口路径 `/admin/api/ctl/bundles`，用户接口路径 `/v1/bundles` |
| CTL 后台任务 | 新增 1 个定时 goroutine | 每天 10:00（UTC+8）刷新售卖配额，与 HTTP Server 共生命周期 |
| CTL 配置 | 新增 `[bundle]` 配置段 | 新增 `credit_token_ratio` 全局配置 |
| CTL ↔ ai-gateway | 新增跨服务调用 | ImportBundle 时调 `GetPlan` 校验；创建 Pass 时调 `ApplySubscription`；查询 Pass 时调 `GetActiveSubscription` |
| admin-gateway | 新增代理路由 | 新增 `/admin/api/ctl/bundles` → CTL 的反向代理规则 |
| ai-gateway | **零代码变更** | 复用现有 Plan/Subscription 能力，运营在 ai-gateway 先创建 Plan |
| 现有配额系统 | **零影响** | 不修改 `user_resource_quota` 的逻辑 |
| service-gateway | **零影响** | 不涉及路由变更 |
| 前端 | 需适配 | 套餐/权益展示从 monthly_tokens → credit（原 monthly_tokens 已不暴露给用户） |

---

## 9. 实施计划

| 阶段 | 任务 | 产出 |
|------|------|------|
| 1 | 数据库 migration | `000013_create_bundle.up.sql` / `.down.sql` |
| 2 | Model 层 | `bundle/entity.go`, `bundle/dao.go` |
| 3 | DaoFactory 注册 | `factory.go` 新增注册 |
| 4 | Logic 层 | `logic/bundle/logic.go` |
| 5 | 错误码 | `errcode/bundle.go` |
| 6 | 单元测试 | DAO 测试 + Logic 测试 |
| 7 | CTL 用户接口 | `GET /v1/bundles` handler（DescribeBundles） |
| 8 | CTL 管理接口 | `POST/GET/PUT /admin/api/ctl/bundles` handler（ImportBundle / GetBundles / ModifyBundles） |
| 9 | admin-gateway 路由配置 | 新增 `/admin/api/ctl/bundles` → CTL 的反向代理规则 |
| 10 | 限量扣减/回滚 DAO | `bundle/dao.go` 新增 `DecrementAvailCount` / `IncrementAvailCount` / `RefreshAllAvailCount` |
| 11 | Pass 创建链路接入限量 | `logic/pass/logic.go` 在创建流程中原子扣减 + defer 回滚 |
| 12 | 每日定时刷新 | `logic/bundle/cron.go` + `main/api/server.go` 启动注册 |
| 13 | Credit 配置 + 换算工具 | `pkg/config/define.go` 新增 `BundleConfig`；`logic/bundle/credit.go` 新增换算函数 |
| 14 | Credit migration | `000016_add_bundle_credit.up.sql` / `.down.sql`（删除 monthly_tokens，新增 credit） |
| 15 | ai-gateway Adapter 扩展 | `adapter/aigateway` 新增 `GetPlan` / `ApplySubscription` / `GetActiveSubscription` 方法 |
| 16 | ImportBundle 强校验接入 | `logic/bundle/logic.go` 在 `ImportBundle` / `ModifyBundles` 中接入 credit/time/plan 三项一致性校验 |
| 17 | Pass 创建接入订阅联动 | `logic/pass/logic.go` 基于 bundle.time_span/time_unit 计算 expired_time；credit>0 时调 `ApplySubscription` 失败时回滚 |
| 18 | Pass 查询 credit 换算 | `logic/pass/logic.go` 的 `DescribePasses` 调 `GetActiveSubscription`，换算为 credit 返回 |
| 19 | 集成测试 | 端到端验证（含 admin-gateway 代理链路、限量扣减、credit 换算、订阅联动、ImportBundle 强校验） |

---

## 10. 开放问题

| # | 问题 | 待确认 |
|---|------|--------|
| 1 | `bundle_id` 的命名规范？ | 建议使用 kebab-case（如 `free-trial`, `basic-5`, `pro-20`），还是使用 UUID？ |
