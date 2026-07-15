# GET /v1/bundles 套餐功能列表 / 积分下发化 —— 后端新增字段与接口文档

> 目的：把订阅页（`frontend/next-site/subscribe-page.tsx`）中**前端硬编码**的「功能特性列表」「一句话卖点」「促销角标」「独立环境规格 / 存储 / 积分」改为**后端 `GET /v1/bundles` 下发**，让启航 / 巡游 / 远航各套餐的展示信息由运营在 bundle 配置里维护，前端只做渲染。
>
> 关联：`product/prd/2026-07-14-subscribe-pricing-optimization.md`（功能点 3/6/7）；后端 handler `ctl/main/api/bundle_handler.go`；DTO `ctl/pkg/transport/bundle.go`；实体 `ctl/pkg/model/bundle/entity.go`。

---

## 1. 背景

当前 `mapBundleToPlan()`（`subscribe-page.tsx` 第 300~548 行）在前端硬编码了套餐卡上几乎所有展示内容：规格数值（2核4G/4核8G）、存储（50G）、能力位（7×24 在线 / Hermes 自主进化 / 自动任务 / 技能安装(包) / 多通道 / 长期记忆）、一句话卖点、促销角标，以及 AI 增强版的积分（4500 / 10000）。这导致：

- 运营调整套餐权益 / 文案必须改前端代码发版；
- 未登录静态展示与登录后展示可能不一致（各写一份）；
- 同一套餐的「标准版 / AI 增强版」差异只能靠前端 tier 名 `includes("启航")` 之类的字符串猜测。

目标：这些信息全部由后端 bundle 配置下发，前端仅渲染。

---

## 2. 现状盘点：后端已下发 vs. 需新增

`GET /v1/bundles` 返回的 `UserBundleResponse`（`ctl/pkg/transport/bundle.go` L92~114）**现有出参**：

```
bundle_id, bundle_name, bundle_type, description[], bundle_state,
agent_quota, credit, bundle_sales_state,
cpu, memory, system_disk_size,      // ← 已下发！前端未消费
price(可空，需登录询价)
```

对照前端硬编码项，分三类处理：

### 2.1 无需新增字段，仅需前端改用（后端早已下发）
| 展示项 | 后端已有字段 | 前端现状 |
|---|---|---|
| 独立环境规格 | `cpu` / `memory` | 忽略后端值，按 tier 名写死 2核4G/4核8G |
| 专属云端存储 | `system_disk_size` | 写死 50G |

> ⚠️ 前端 `Bundle` 类型（`frontend/src/domain/types.ts` L269）**缺失** `cpu/memory/system_disk_size` 字段，需补上后即可消费。

### 2.2 无需新增字段，仅需数据配置
| 展示项 | 后端已有字段 | 待办 |
|---|---|---|
| AI 增强版积分 | `credit` | 给 `bundle_launch_ai_01` 配 `credit=4500`、`bundle_cruise_ai_01` 配 `credit=10000`（当前前端 `AI_VARIANT_CREDIT` 写死，改为读 `bundle.credit`） |

### 2.3 需要后端新增的字段（本文档重点）
| # | 新增字段 | 类型 | 用途 | 对应前端硬编码 |
|---|---|---|---|---|
| 1 | `features` | 结构化数组 | 功能特性列表（能力位 + 带值项） | 7×24 在线 / Hermes 自主进化 / 自动任务 / 技能安装(包) / 多通道 / 长期记忆等 |
| 2 | `tagline` | string | 套餐一句话卖点 | 启航「低成本上手…」等（PRD 功能点7） |
| 3 | `promotion` | 结构化对象(可空) | 促销角标文案 + 折扣元数据 | 免费14天 / 首月5折 / 首月6折（PRD 功能点6） |

---

## 3. 新增字段定义

### 3.1 DB 迁移（`ctl/migrations/000024_add_bundle_display_fields.up.sql`）

```sql
-- 套餐展示化改造：功能特性列表 / 一句话卖点 / 促销角标 由 bundle 配置下发，
-- 替代订阅页前端硬编码（PRD 2026-07-14 功能点 3/6/7）。
-- 三列均为 user-facing 出参，不参与 trade 询价、不影响下单链路。
ALTER TABLE `bundle`
    ADD COLUMN `features`  JSON         NULL COMMENT '功能特性列表 JSON：[{"key","label","value","included","highlight"}]' AFTER `description`,
    ADD COLUMN `tagline`   VARCHAR(255) NOT NULL DEFAULT '' COMMENT '套餐一句话卖点文案' AFTER `features`,
    ADD COLUMN `promotion` JSON         NULL COMMENT '促销角标 JSON：{"label","kind","discount","first_period_only"}；无促销为 NULL' AFTER `tagline`;
```

对应 down 迁移删除三列。历史数据不 backfill：`features`/`promotion` 为 NULL、`tagline` 为空串时，前端回退到既有兜底逻辑（保证灰度期不炸）。

### 3.2 实体（`ctl/pkg/model/bundle/entity.go`）

```go
// 新增列常量
ColumnFeatures  = "features"
ColumnTagline   = "tagline"
ColumnPromotion = "promotion"

// Entity 追加字段
Features  string `gorm:"column:features;type:json"`   // JSON: []DisplayFeature
Tagline   string `gorm:"column:tagline"`
Promotion string `gorm:"column:promotion;type:json"`  // JSON: *DisplayPromotion，可空
```

### 3.3 结构体（`ctl/pkg/transport/bundle.go`）

```go
// DisplayFeature 套餐功能特性项（user-facing 下发，前端直接渲染，不再按 tier 名硬编码）。
type DisplayFeature struct {
    // Key 稳定语义键，前端据此映射图标（icon），与文案解耦。
    // 约定枚举（可扩展）：env / storage / credit / online_247 / self_evolution /
    //   auto_task / skill_install / skill_pack / multi_channel / long_memory / config_panel
    Key string `json:"key"`
    // Label 展示文案（后端直出中文；i18n 由前端字典兜底）。
    Label string `json:"label"`
    // Value 右侧数值/描述；为空时前端展示为「✓ 勾选」样式（纯能力位）。
    Value string `json:"value,omitempty"`
    // Included 是否包含该能力；false 可用于「不含 xx」置灰展示（本期一般恒为 true）。
    Included bool `json:"included"`
    // Highlight 是否高亮强调（如核心卖点）。
    Highlight bool `json:"highlight,omitempty"`
}

// DisplayPromotion 促销角标（user-facing），无促销时整体为 nil。
type DisplayPromotion struct {
    // Label 角标文案，如「免费 14 天」「首月 5 折」「首月 6 折」。
    Label string `json:"label"`
    // Kind 促销类型：free_trial（免费试用）/ first_period_discount（首期折扣）/ none。
    Kind string `json:"kind"`
    // Discount 折扣率(0,1)；如 0.5=5折、0.6=6折；free_trial 时为 0。
    Discount float64 `json:"discount,omitempty"`
    // FirstPeriodOnly 折扣是否仅首期生效（首月 6 折后续原价 → true）。
    FirstPeriodOnly bool `json:"first_period_only,omitempty"`
}
```

`UserBundleResponse` 追加三字段：

```go
type UserBundleResponse struct {
    // ... 现有字段不变 ...
    CPU            int `json:"cpu"`
    Memory         int `json:"memory"`
    SystemDiskSize int `json:"system_disk_size"`

    // === 新增：展示化字段（本次改造）===
    Features  []DisplayFeature  `json:"features"`            // 功能特性列表，NULL 时返回 []
    Tagline   string            `json:"tagline"`             // 一句话卖点，可为空串
    Promotion *DisplayPromotion `json:"promotion,omitempty"` // 促销角标，无促销时省略

    Price *BundlePrice `json:"price,omitempty"`
}
```

> `features` 建议**始终返回数组**（无配置时 `[]`），避免前端 null 判空；`promotion` 用 `omitempty` 指针，无促销时不下发。

---

## 4. 接口文档：`GET /v1/bundles`

### 4.1 基本信息
| 项 | 说明 |
|---|---|
| Method / Path | `GET /v1/bundles` |
| 鉴权 | **公开可匿名访问**（service-gateway `AccessPublic`）。携带 `X-User-Id`（登录）时回填 `price`；匿名时 `price=null` |
| Query | `time_span`（int，默认 1）、`time_unit`（string，默认 `m`；`m`月 / `y`年）—— 仅影响询价 `price`，**不影响** features/tagline/credit/规格 |
| 说明 | `features` / `tagline` / `promotion` / `credit` / `cpu` / `memory` / `system_disk_size` 均为 bundle 静态配置，**登录与否都完整下发**；仅 `price` 依赖登录询价 |

### 4.2 新出参字段说明
| 字段 | 类型 | 是否新增 | 匿名可见 | 说明 |
|---|---|---|---|---|
| `agent_quota` | int | 否 | ✅ | Agent 席位数 |
| `credit` | int | 否 | ✅ | 套餐含平台积分数（AI 增强版需在 bundle 配置里填 4500/10000） |
| `cpu` | int | 否(已存在) | ✅ | 独立环境 CPU 核数（替代前端写死 2核/4核） |
| `memory` | int | 否(已存在) | ✅ | 内存 GB（替代前端写死 4G/8G） |
| `system_disk_size` | int | 否(已存在) | ✅ | 系统盘 GB（替代前端写死 50G） |
| `features` | DisplayFeature[] | **是** | ✅ | 功能特性列表；空配置返回 `[]` |
| `tagline` | string | **是** | ✅ | 一句话卖点；空配置返回 `""` |
| `promotion` | DisplayPromotion? | **是** | ✅ | 促销角标；无促销时字段省略 |
| `price` | BundlePrice? | 否 | ❌ 匿名为 null | 询价结果，仅登录态回填 |

### 4.3 响应示例（登录态，启航 Launch 标准版）

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "bundles": [
      {
        "bundle_id": "bundle_launch_01",
        "bundle_name": "启航 Launch",
        "bundle_type": "general",
        "bundle_state": "ONLINE",
        "bundle_sales_state": "AVAILABLE",
        "agent_quota": 1,
        "credit": 1500,
        "cpu": 2,
        "memory": 4,
        "system_disk_size": 50,
        "tagline": "低成本上手，先让 Agent 替你跑起来",
        "features": [
          { "key": "env",            "label": "独立环境",     "value": "2核 4G 内存", "included": true },
          { "key": "storage",        "label": "专属云端存储", "value": "50G",         "included": true },
          { "key": "credit",         "label": "模型积分",     "value": "1500 积分/月","included": true },
          { "key": "auto_task",      "label": "自动任务",     "included": true },
          { "key": "skill_install",  "label": "技能安装",     "included": true },
          { "key": "multi_channel",  "label": "微信、QQ等多通道", "included": true },
          { "key": "long_memory",    "label": "长期记忆",     "included": true },
          { "key": "self_evolution", "label": "Hermes Agent 自主进化", "included": true, "highlight": true },
          { "key": "online_247",     "label": "7×24 在线",    "included": true }
        ],
        "promotion": {
          "label": "免费 14 天",
          "kind": "free_trial",
          "discount": 0,
          "first_period_only": true
        },
        "price": {
          "price": 4900, "total_cost": 4900, "real_total_cost": 4900,
          "currency": "CNY", "discount": 1.0
        }
      }
    ]
  }
}
```

### 4.4 响应示例（AI 增强版，敬请期待 —— 巡游 Cruise AI）

```json
{
  "bundle_id": "bundle_cruise_ai_01",
  "bundle_name": "巡游 Cruise",
  "bundle_type": "ai",
  "bundle_state": "ONLINE",
  "bundle_sales_state": "AVAILABLE",
  "agent_quota": 1,
  "credit": 10000,
  "cpu": 4, "memory": 8, "system_disk_size": 50,
  "tagline": "日常主力，让智能化成为习惯",
  "features": [
    { "key": "env",     "label": "独立环境",     "value": "4核 8G 内存", "included": true },
    { "key": "storage", "label": "专属云端存储", "value": "50G",         "included": true },
    { "key": "credit",  "label": "模型积分",     "value": "10000 积分/月","included": true },
    { "key": "skill_pack", "label": "技能包",    "included": true }
  ],
  "promotion": {
    "label": "首月 6 折", "kind": "first_period_discount",
    "discount": 0.6, "first_period_only": true
  },
  "price": null
}
```

> AI 增强版本期展示「敬请期待」、不露价：`price` 保持 null（可不参与询价），前端 `planTiers` 仍强制 comingSoon。`credit` 由后端下发替代前端 `AI_VARIANT_CREDIT` 写死。

### 4.5 匿名（未登录）响应
与登录态一致，唯一差异是 `price=null`（trade 需要 `X-User-Id` 才询价）。这意味着改造后：**功能列表、积分、规格、卖点、促销角标未登录也能从后端拿到真实值**，无需再前端写死一份静态特性表（未登录只有「价格」仍需前端静态兜底或展示「登录后查看价格」）。

---

## 5. 促销角标（`promotion`）与后端 `discount` 的关系

- 现状：前端按 `bundle_name + bundle_type` 猜促销文案（启航不带Token免费14天 / 带Token首月6折 / 巡游不带Token首月5折 / 带Token首月6折），后端 `price.discount` 仅在真实打折时才有值。
- 建议：促销**文案与元数据**统一由 `promotion` 下发，`price.discount` 仍保留用于实际扣费。前端优先用 `promotion.label`；无 `promotion` 时回退到既有 `discount` 推导逻辑（兼容灰度）。

---

## 6. 落地清单

### 后端（ctl）
1. `migrations/000024_add_bundle_display_fields.{up,down}.sql`：新增 `features` / `tagline` / `promotion` 三列。
2. `pkg/model/bundle/entity.go`：`Entity` 加 3 字段 + 列常量。
3. `pkg/transport/bundle.go`：新增 `DisplayFeature` / `DisplayPromotion`；`UserBundleResponse`（及 admin `BundleResponse`）加 3 字段；`ImportBundleRequest` / `ModifyBundlesRequest` 加 3 入参（供运营配置）。
4. `pkg/logic/bundle/logic.go` + `main/api/bundle_handler.go`：`detailToUserResponse` / `detailToAdminResponse` 透出新字段（`features` 空→`[]`，`promotion` 空→nil）；`ImportBundle` / `ModifyBundles` 支持写入。
5. 数据配置：给各 bundle 配置 `features` / `tagline` / `promotion`；给 `bundle_*_ai_01` 配 `credit`（4500 / 10000）。

### 前端（次级改造，本次仅出后端契约，前端联调后再改）
1. `frontend/src/domain/types.ts` `Bundle` 补 `cpu` / `memory` / `system_disk_size` / `features` / `tagline` / `promotion`。
2. `subscribe-page.tsx` `mapBundleToPlan`：优先消费 `bundle.features`（有则直接渲染，去掉硬编码能力位）；规格用 `bundle.cpu/memory/system_disk_size`；`tagline`/`promotion` 用后端值；`AI_VARIANT_CREDIT` 改读 `bundle.credit`。均保留「后端缺字段→旧硬编码兜底」的降级分支，保证灰度平滑。

---

## 7. 兼容性与灰度
- 三列均可空，老数据 / 未配置 bundle 返回 `features:[]` + `tagline:""` + 无 `promotion`，前端回退旧硬编码逻辑，**不阻断展示**。
- 不影响 trade 询价 / 下单链路（新字段是纯展示，internal RPC `InternalBundleDetail` 无需暴露）。
- 建议后端先上线（下发字段），前端灰度开关控制「优先用后端 features / 回退硬编码」，逐 bundle 配置齐后再全量切换。
