# 套餐（Bundle）与权益（Pass） — 前后端联调文档

> 更新时间：2026-04-20  
> 后端服务：CTL  
> 接入方式：
> - **用户端**：通过 `service-gateway` 转发，请求头自动携带 `X-User-Id`
> - **管理端**：通过 `admin-gateway` 转发，路径前缀 `/admin/api/ctl/`，需管理员鉴权

---

## 1. 整体流程

### 1.1 管理端 — Bundle 管理

```
┌──────────┐  POST /admin/api/ctl/bundles   ┌──────┐
│ 管理后台  │ ─────────────────────────────▶ │  CTL │   ① 导入/创建套餐
│          │◀──── bundle 详情 ────────────  │      │
│          │                                │      │
│          │  GET /admin/api/ctl/bundles     │      │
│          │ ─────────────────────────────▶ │      │   ② 查询所有套餐（含 OFFLINE）
│          │◀──── bundles 列表 ───────────  │      │
│          │                                │      │
│          │  PUT /admin/api/ctl/bundles     │      │
│          │ ─────────────────────────────▶ │      │   ③ 批量修改套餐（上下线/改配置）
│          │◀──── affected_count ─────────  │      │
└──────────┘                                └──────┘
```

### 1.2 用户端 — 购买与查询

```
┌─────────┐     GET /v1/passes       ┌──────┐
│  前端    │ ─────────────────────── ▶│  CTL │   ① 先查"我的权益"
│         │◀──── passes 列表 ──────  │      │
│         │                          │      │
│         │  passes 为空？            │      │
│         │  ├─ 是（新用户）          │      │
│         │  │                       │      │
│         │  │  GET /v1/bundles      │      │
│         │  │ ─────────────────── ▶ │      │   ② 拉取可选套餐
│         │  │◀── bundles 列表 ──── │      │
│         │  │                       │      │
│         │  │  POST /v1/passes      │      │
│         │  │ ─────────────────── ▶ │      │   ③ 选择套餐，下单
│         │  │◀── pass 详情 ──────  │      │
│         │  │                       │      │
│         │  └─ 否（存量用户）        │      │
│         │     → 直接展示权益详情    │      │
└─────────┘                          └──────┘
```

**前端推荐调用流程**：

1. **页面加载时先调 `GET /v1/passes`**，查询当前用户是否已有权益
   - **`passes` 数组非空**（存量用户）：直接展示权益详情页（套餐名称、到期时间、积分余量等），**跳过套餐选择流程**
   - **`passes` 数组为空**（新用户）：进入套餐选择流程 ↓
2. 调 `GET /v1/bundles` 拉取所有上线套餐
   - 对于 `bundle_sales_state == "SOLD_OUT"` 的套餐，**购买按钮置灰并显示"已售罄"**，禁止点击下单
   - 对于 `bundle_sales_state == "AVAILABLE"` 的套餐，正常展示购买按钮
3. 用户选择一个可购买的套餐，前端调 `POST /v1/passes` 传入 `bundle_id` 完成购买
4. 购买成功后，跳转到权益详情页（或重新调 `GET /v1/passes` 刷新）

> **⚠️ 重要**：售罄判断以 `bundle_sales_state` 字段为准，**不要**用 `bundle_sales_available_count == 0` 自行判断，因为后端还有 `static_sold_out`（运营手动售罄）的逻辑。

---

## 2. 接口列表

### 管理端（admin-gateway）

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| `POST` | `/admin/api/ctl/bundles` | 导入套餐（Upsert：不存在创建，存在覆盖） | 管理员 |
| `GET` | `/admin/api/ctl/bundles` | 查询所有套餐（含 ONLINE + OFFLINE） | 管理员 |
| `PUT` | `/admin/api/ctl/bundles` | 批量修改套餐 | 管理员 |
| `POST` | `/admin/api/ctl/passes` | 管理端创建 Pass | 管理员 |
| `GET` | `/admin/api/ctl/passes` | 管理端查询 Pass 列表 | 管理员 |
| `PUT` | `/admin/api/ctl/passes` | 管理端修改 Pass | 管理员 |

### 用户端（service-gateway）

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| `GET` | `/v1/bundles` | 查询上线套餐列表（仅 ONLINE） | `X-User-Id` |
| `POST` | `/v1/passes` | 创建权益（购买套餐） | `X-User-Id` |
| `GET` | `/v1/passes` | 查询我的权益列表 | `X-User-Id` |

---

## 3. 管理端接口详情

### 3.1 导入套餐 — `POST /admin/api/ctl/bundles`

Upsert 语义：`bundle_id` 不存在时创建，已存在时覆盖更新。新导入的套餐默认 `bundle_state=OFFLINE`，需通过 `PUT` 接口修改为 `ONLINE` 才对用户可见。

#### 请求

```json
{
    "bundle_id": "bun-free-trial-001",
    "bundle_name": "免费体验版",
    "description": [
        { "Key": "体验Agent", "Value": "至多2个" },
        { "Key": "独立环境", "Value": "" },
        { "Key": "7*24小时在线", "Value": "" },
        { "Key": "专属云端存储", "Value": "" },
        { "Key": "极简配置面板", "Value": "" }
    ],
    "agent_quota": 1,
    "credit": 0,
    "time_span": 1,
    "time_unit": "m",
    "ai_gateway_plan_id": "",
    "static_sold_out": false,
    "bundle_sales_available_count": 9999,
    "bundle_sales_total_count": 9999
}
```

#### 请求字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `bundle_id` | string | ✅ | 套餐唯一标识。建议用 `bun-<类型>-<序号>` 命名，如 `bun-free-trial-001` |
| `bundle_name` | string | ✅ | 套餐展示名称 |
| `description` | array | ✅ | 结构化描述 `[{Key, Value}]`，用于前端展示套餐卖点 |
| `agent_quota` | int | ✅ | 该套餐允许创建的 Agent 数量。`0` 表示不限 |
| `credit` | int | ✅ | 积分额度（用户可见）。`0` 表示不含 AI 积分 |
| `time_span` | int | ✅ | 套餐周期数值。必须 > 0 |
| `time_unit` | string | ✅ | 套餐周期单位：`"m"` = 月，`"d"` = 天 |
| `ai_gateway_plan_id` | string | 条件必填 | ai-gateway Plan UUID。`credit=0` 时**必须为空**；`credit>0` 时**必须非空** |
| `static_sold_out` | bool | ✅ | 静态售罄标记。`true` 时无论剩余名额多少，用户端都显示售罄 |
| `bundle_sales_available_count` | int | ✅ | 当日可售名额。每日 10:00（北京时间）由定时任务重置为 `total_count` |
| `bundle_sales_total_count` | int | ✅ | 每日总可售量 |

#### 三项一致性校验规则

导入时后端自动校验，不通过直接返回错误：

| 规则 | 条件 | 校验内容 |
|------|------|----------|
| **规则1** | 所有套餐 | `time_unit` ∈ `{"m", "d"}` 且 `time_span > 0` |
| **规则2** | `credit = 0` | `ai_gateway_plan_id` 必须为空字符串 |
| **规则3** | `credit > 0` | `ai_gateway_plan_id` 必须非空，且远程校验 Plan 的 `monthly_tokens == credit × 10000`，`period_value == time_span`，`period_unit` 匹配 `time_unit` |

#### 成功响应

```json
{
    "code": "OK",
    "message": "OK",
    "data": {
        "bundle_id": "bun-free-trial-001",
        "bundle_name": "免费体验版",
        "description": [
            { "Key": "体验Agent", "Value": "至多2个" },
            { "Key": "独立环境", "Value": "" },
            { "Key": "7*24小时在线", "Value": "" },
            { "Key": "专属云端存储", "Value": "" },
            { "Key": "极简配置面板", "Value": "" }
        ],
        "bundle_state": "OFFLINE",
        "agent_quota": 1,
        "credit": 0,
        "time_span": 1,
        "time_unit": "m",
        "ai_gateway_plan_id": "",
        "static_sold_out": false,
        "bundle_sales_available_count": 9999,
        "bundle_sales_total_count": 9999,
        "bundle_sales_state": "AVAILABLE",
        "created_time": "2026-04-20T10:00:00Z",
        "updated_time": "2026-04-20T10:00:00Z"
    },
    "request_id": "xxx"
}
```

#### 错误码

| code | HTTP | 含义 |
|------|------|------|
| `BUNDLE_CONFIG_INVALID` | 400 | 基础参数校验失败（bundle_id 为空、agent_quota < 0、time_span <= 0 等） |
| `BUNDLE_PLAN_MISMATCH` | 400 | credit/plan_id 关联关系不合法（credit=0 但 plan_id 非空，或反之） |
| `BUNDLE_PLAN_NOT_FOUND` | 400 | ai-gateway 中找不到指定的 Plan |
| `BUNDLE_CREDIT_TOKEN_MISMATCH` | 400 | Plan 的 monthly_tokens 与 credit × ratio 不匹配 |
| `BUNDLE_PERIOD_MISMATCH` | 400 | Plan 的周期与 bundle 的 time_span/time_unit 不匹配 |
| `BUNDLE_AIGATEWAY_UNAVAILABLE` | 502 | 无法连接 ai-gateway 进行校验 |

---

### 3.2 查询所有套餐 — `GET /admin/api/ctl/bundles`

**无请求参数。** 返回所有套餐（包含 `ONLINE` 和 `OFFLINE`）。

#### 响应

```json
{
    "code": "OK",
    "message": "OK",
    "data": {
        "bundles": [
            {
                "bundle_id": "bun-free-trial-001",
                "bundle_name": "免费体验版",
                "description": [
                    { "Key": "体验Agent", "Value": "至多2个" },
                    { "Key": "独立环境", "Value": "" },
                    { "Key": "7*24小时在线", "Value": "" },
                    { "Key": "专属云端存储", "Value": "" },
                    { "Key": "极简配置面板", "Value": "" }
                ],
                "bundle_state": "ONLINE",
                "agent_quota": 1,
                "credit": 0,
                "time_span": 1,
                "time_unit": "m",
                "ai_gateway_plan_id": "",
                "static_sold_out": false,
                "bundle_sales_available_count": 9999,
                "bundle_sales_total_count": 9999,
                "bundle_sales_state": "AVAILABLE",
                "created_time": "2026-04-20T10:00:00Z",
                "updated_time": "2026-04-20T10:00:00Z"
            }
        ]
    },
    "request_id": "xxx"
}
```

#### 管理端响应字段（完整版，含内部字段）

| 字段 | 类型 | 说明 |
|------|------|------|
| `bundle_id` | string | 套餐唯一标识 |
| `bundle_name` | string | 套餐展示名称 |
| `description` | array | 结构化描述 `[{Key, Value}]` |
| `bundle_state` | string | `"ONLINE"` 或 `"OFFLINE"` |
| `agent_quota` | int | 允许创建的 Agent 数量 |
| `credit` | int | 积分额度。`0` 表示不含 AI 积分 |
| `time_span` | int | 套餐周期数值 |
| `time_unit` | string | `"m"` = 月，`"d"` = 天 |
| `ai_gateway_plan_id` | string | 关联的 ai-gateway Plan UUID（**仅管理端可见**） |
| `static_sold_out` | bool | 静态售罄标记（**仅管理端可见**） |
| `bundle_sales_available_count` | int | 当日剩余可购买数量 |
| `bundle_sales_total_count` | int | 每日总可售量 |
| `bundle_sales_state` | string | 计算字段：`"AVAILABLE"` 或 `"SOLD_OUT"` |
| `created_time` | string (RFC3339) | 创建时间 |
| `updated_time` | string (RFC3339) | 最后更新时间 |

---

### 3.3 批量修改套餐 — `PUT /admin/api/ctl/bundles`

支持部分更新（Patch 语义）：只传需要修改的字段，未传的字段保持不变。

#### 请求

```json
{
    "bundle_ids": ["bun-free-trial-001"],
    "bundle_state": "ONLINE"
}
```

**上线示例**（只改状态）：
```json
{
    "bundle_ids": ["bun-free-trial-001"],
    "bundle_state": "ONLINE"
}
```

**修改售卖配置示例**：
```json
{
    "bundle_ids": ["bun-free-trial-001"],
    "bundle_sales_available_count": 200,
    "bundle_sales_total_count": 200,
    "static_sold_out": false
}
```

**手动售罄示例**：
```json
{
    "bundle_ids": ["bun-free-trial-001"],
    "static_sold_out": true
}
```

#### 请求字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `bundle_ids` | string[] | ✅ | 要修改的套餐 ID 列表 |
| `bundle_name` | string | | 套餐名称 |
| `description` | string | | JSON 字符串格式的描述内容 |
| `bundle_state` | string | | `"ONLINE"` 或 `"OFFLINE"` |
| `agent_quota` | int | | Agent 数量限额 |
| `credit` | int | | 积分额度 |
| `time_span` | int | | 周期数值 |
| `time_unit` | string | | 周期单位 `"m"` / `"d"` |
| `ai_gateway_plan_id` | string | | Plan UUID |
| `static_sold_out` | bool | | 静态售罄标记 |
| `bundle_sales_available_count` | int | | 当日可售名额 |
| `bundle_sales_total_count` | int | | 每日总可售量 |

> **注**：当修改 `credit`、`time_span`、`time_unit`、`ai_gateway_plan_id` 中任一字段时，后端会对每个目标 bundle 重新执行三项一致性校验（合并已有值 + 新值后校验）。

#### 成功响应

```json
{
    "code": "OK",
    "message": "OK",
    "data": {
        "affected_count": 2
    },
    "request_id": "xxx"
}
```

#### 错误码

| code | HTTP | 含义 |
|------|------|------|
| `BUNDLE_IDS_EMPTY` | 400 | `bundle_ids` 为空数组 |
| `BUNDLE_NO_FIELD_TO_UPDATE` | 400 | 除 `bundle_ids` 外没有传任何修改字段 |
| `BUNDLE_STATE_INVALID` | 400 | `bundle_state` 不是 `ONLINE` / `OFFLINE` |
| `BUNDLE_CONFIG_INVALID` | 400 | 字段值不合法（如 agent_quota < 0） |
| `BUNDLE_PARTIAL_NOT_FOUND` | 400 | 部分 bundle_id 在数据库中不存在 |
| `BUNDLE_PLAN_MISMATCH` | 400 | 修改后的 credit/plan_id 关联关系不合法 |
| `BUNDLE_PLAN_NOT_FOUND` | 400 | ai-gateway 中找不到指定的 Plan |
| `BUNDLE_CREDIT_TOKEN_MISMATCH` | 400 | Plan 的 monthly_tokens 与 credit × ratio 不匹配 |
| `BUNDLE_PERIOD_MISMATCH` | 400 | Plan 的周期与 bundle 的 time_span/time_unit 不匹配 |
| `BUNDLE_AIGATEWAY_UNAVAILABLE` | 502 | 无法连接 ai-gateway 进行校验 |

---

## 4. 用户端接口详情

### 4.1 查询上线套餐 — `GET /v1/bundles`

**无请求参数。** 仅返回 `bundle_state=ONLINE` 的套餐。

#### 响应

```json
{
    "code": "OK",
    "message": "OK",
    "data": {
        "bundles": [
            {
                "bundle_id": "bun-free-trial-001",
                "bundle_name": "免费体验版",
                "description": [
                    { "Key": "体验Agent", "Value": "至多2个" },
                    { "Key": "独立环境", "Value": "" },
                    { "Key": "7*24小时在线", "Value": "" },
                    { "Key": "专属云端存储", "Value": "" },
                    { "Key": "极简配置面板", "Value": "" }
                ],
                "bundle_state": "ONLINE",
                "agent_quota": 1,
                "credit": 0,
                "bundle_sales_state": "AVAILABLE"
            }
        ]
    },
    "request_id": "xxx"
}
```

#### 用户端响应字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `bundle_id` | string | 套餐唯一标识，购买时传此值 |
| `bundle_name` | string | 套餐展示名称 |
| `description` | array | 结构化描述 `[{Key, Value}]`，用于前端展示套餐卖点 |
| `bundle_state` | string | 固定 `"ONLINE"`（此接口只返回上线套餐） |
| `agent_quota` | int | 该套餐允许创建的 Agent 数量 |
| `credit` | int | 积分额度（用户可见的 AI 使用额度）。`0` 表示不含 AI 积分 |
| `bundle_sales_state` | string | `"AVAILABLE"` = 可购买，`"SOLD_OUT"` = 售罄 |

> **注**：以下字段**不会**出现在用户端响应中：`time_span`、`time_unit`、`ai_gateway_plan_id`、`static_sold_out`、`bundle_sales_available_count`、`bundle_sales_total_count`、`created_time`、`updated_time`（均为内部管理字段）。

#### 前端展示建议

- **积分展示**：`credit > 0` → 展示积分额度；`credit == 0` → 不展示积分行
- **售罄处理**（重要）：
  - 判断依据：**以 `bundle_sales_state` 字段为准**
  - `"SOLD_OUT"` → 购买按钮**置灰**，显示"已售罄"文案，**禁止点击**
  - `"AVAILABLE"` → 正常展示购买按钮
- **套餐周期/有效期等展示信息**：由 `description` 数组中的 KV 条目承载，前端直接渲染即可

---

### 4.2 创建权益（购买套餐） — `POST /v1/passes`

#### 请求

```json
{
    "bundle_id": "bun-free-trial-001"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `bundle_id` | string | ✅ | 要购买的套餐 ID（从 `/v1/bundles` 响应中获取） |

> **注**：不需要传 `user_id`（自动取当前登录用户），不需要传购买时长（由套餐配置决定）。

#### 成功响应

```json
{
    "code": "OK",
    "message": "OK",
    "data": {
        "pass_id": "pass-jyxpuid0",
        "user_id": "user-abc123",
        "bundle_id": "bun-free-trial-001",
        "bundle_name": "免费体验版",
        "uin": 0,
        "app_id": 0,
        "created_time": "2026-04-20T12:00:00Z",
        "expired_time": "2026-05-20T12:00:00Z",
        "isolated_time": null,
        "deleted_time": null,
        "updated_time": "2026-04-20T12:00:00Z",
        "credit_total": 0,
        "credit_available": 0
    },
    "request_id": "xxx"
}
```

#### 错误码

| code | HTTP | 含义 | 前端处理建议 |
|------|------|------|------------|
| `PASS_INVALID_PARAM` | 400 | 参数缺失（如 bundle_id 为空） | 提示"请选择套餐" |
| `BUNDLE_NOT_FOUND` | 404 | 套餐不存在 | 提示"套餐已下架" |
| `PASS_BUNDLE_OFFLINE` | 400 | 套餐已下线 | 提示"该套餐已下线" |
| `PASS_BUNDLE_SOLD_OUT` | 400 | 静态售罄（运营手动关闭） | 提示"该套餐暂时售罄" |
| `BUNDLE_SALES_QUOTA_EMPTY` | 400 | 今日售卖名额已用完 | 提示"今日名额已抢完，明天再试" |
| `PASS_ALREADY_EXISTS` | 409 | 用户已有活跃权益 | 提示"您已拥有权益，无需重复购买" |
| `PASS_QUOTA_EXCEEDED` | 403 | 已使用配额超过套餐上限 | 提示"当前使用量超出该套餐限额" |

---

### 4.3 查询我的权益 — `GET /v1/passes`

**无请求参数。** 自动按当前登录用户查询。

#### 响应

```json
{
    "code": "OK",
    "message": "OK",
    "data": {
        "passes": [
            {
                "pass_id": "pass-jyxpuid0",
                "user_id": "user-abc123",
                "bundle_id": "bun-free-trial-001",
                "bundle_name": "免费体验版",
                "uin": 0,
                "app_id": 0,
                "created_time": "2026-04-20T12:00:00Z",
                "expired_time": "2026-05-20T12:00:00Z",
                "isolated_time": null,
                "deleted_time": null,
                "updated_time": "2026-04-20T12:00:00Z",
                "credit_total": 0,
                "credit_available": 0
            }
        ]
    },
    "request_id": "xxx"
}
```

#### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `pass_id` | string | 权益唯一标识 |
| `user_id` | string | 持有用户 |
| `bundle_id` | string | 关联套餐 ID |
| `bundle_name` | string | 关联套餐名称（展示用） |
| `created_time` | string (RFC3339) | 购买时间 |
| `expired_time` | string (RFC3339) | 到期时间 |
| `credit_total` | int | 积分总量（套餐额度）。`0` 表示该套餐不含积分 |
| `credit_available` | int | 积分剩余（实时）。用户使用 AI 功能时消耗 |
| `isolated_time` | string/null | 预留字段，当前始终 null |
| `deleted_time` | string/null | 预留字段，当前始终 null |

> **注**：`uin` 和 `app_id` 当前始终为 0（后续接入账号系统后补充），前端可忽略。

#### 前端展示建议

- **新老用户分流**（重要）：
  - `passes` 数组**非空** → 存量用户，直接展示权益详情，**不要跳转套餐选择页**
  - `passes` 数组**为空** → 新用户，引导前往套餐选择页（`GET /v1/bundles`）
- **权益状态**：比较 `expired_time` 与当前时间，过期则显示"已过期"
- **积分进度条**：`credit_available / credit_total`（如 87/100 = 87%）
- **积分为 0 时**：不展示积分相关 UI（该套餐不含 AI 积分）

---

## 5. 通用响应格式

### 成功

```json
{
    "code": "OK",
    "message": "OK",
    "data": { ... },
    "request_id": "uuid"
}
```

### 失败

```json
{
    "code": "PASS_ALREADY_EXISTS",
    "message": "user already has an active pass",
    "request_id": "uuid"
}
```

- `code`：业务错误码（字符串），用于前端逻辑判断
- `message`：英文错误描述，前端可直接展示或根据 code 映射中文
- `request_id`：请求追踪 ID，排障时提供给后端

---

## 6. 错误码速查表

### Bundle 错误码

| code | HTTP | 说明 | 触发场景 |
|------|------|------|---------|
| `BUNDLE_NOT_FOUND` | 404 | 套餐不存在 | 购买 Pass 时套餐已被删除 |
| `BUNDLE_CONFIG_INVALID` | 400 | 套餐配置无效 | ImportBundle 参数校验失败 |
| `BUNDLE_STATE_INVALID` | 400 | 状态值不合法 | ModifyBundles 传了非法状态 |
| `BUNDLE_IDS_EMPTY` | 400 | bundle_ids 为空 | ModifyBundles 未传 bundle_ids |
| `BUNDLE_NO_FIELD_TO_UPDATE` | 400 | 无可修改字段 | ModifyBundles 未传任何修改字段 |
| `BUNDLE_PARTIAL_NOT_FOUND` | 400 | 部分套餐不存在 | ModifyBundles 中部分 ID 不存在 |
| `BUNDLE_SALES_QUOTA_EMPTY` | 400 | 今日可售名额已用完 | 购买 Pass 时当日名额已抢光 |
| `BUNDLE_PLAN_MISMATCH` | 400 | credit/plan_id 关联不合法 | ImportBundle/ModifyBundles 校验失败 |
| `BUNDLE_PLAN_NOT_FOUND` | 400 | ai-gateway Plan 不存在 | ImportBundle/ModifyBundles 校验失败 |
| `BUNDLE_CREDIT_TOKEN_MISMATCH` | 400 | Token 映射不匹配 | Plan.monthly_tokens ≠ credit × ratio |
| `BUNDLE_PERIOD_MISMATCH` | 400 | 周期不匹配 | Plan.period ≠ bundle.time_span/time_unit |
| `BUNDLE_AIGATEWAY_UNAVAILABLE` | 502 | ai-gateway 不可达 | 校验 Plan 时 ai-gateway 超时/异常 |

### Pass 错误码

| code | HTTP | 说明 | 触发场景 |
|------|------|------|---------|
| `PASS_INVALID_PARAM` | 400 | 请求参数无效 | 缺少 bundle_id 等 |
| `PASS_BUNDLE_OFFLINE` | 400 | 套餐已下线 | 购买的套餐 state=OFFLINE |
| `PASS_BUNDLE_SOLD_OUT` | 400 | 套餐静态售罄 | static_sold_out=true |
| `PASS_ALREADY_EXISTS` | 409 | 用户已有活跃权益 | 重复购买 |
| `PASS_QUOTA_EXCEEDED` | 403 | 使用量超出套餐限额 | 当前 Agent 数 > 新套餐限额 |

---

## 7. 业务约束

| 约束 | 说明 |
|------|------|
| 一人一权益 | 同一用户同一时间只能持有一个 Pass。重复购买返回 `PASS_ALREADY_EXISTS` |
| 周期不可选 | 购买时不传周期参数。不同时长是不同的 Bundle（如月卡/季卡/年卡各一个 bundle_id） |
| 导入默认下线 | 新导入的 Bundle 默认 `OFFLINE`，需管理端 PUT 上线后才对用户可见 |
| 每日限量 | `bundle_sales_available_count` 每日 10:00（北京时间）自动重置。当天售罄后返回 `BUNDLE_SALES_QUOTA_EMPTY` |
| 积分实时 | `credit_available` 是实时值，用户每次 AI 调用都会扣减 |
| 积分不可见底层 Token | 前端只展示 `credit`，不展示 token 相关信息。换算关系：`1 credit = 10000 token`（可配置） |
| 修改触发重校验 | 通过 PUT 修改 `credit`/`time_span`/`time_unit`/`ai_gateway_plan_id` 中任一字段，会重新校验三项一致性 |

---

## 8. 管理端操作指南

### 8.1 新套餐上线流程

```
① POST /admin/api/ctl/bundles    -- 导入套餐配置（默认 OFFLINE）
② 确认配置无误
③ PUT  /admin/api/ctl/bundles    -- 修改 bundle_state 为 ONLINE
④ GET  /admin/api/ctl/bundles    -- 确认状态已更新
```

### 8.2 套餐下线流程

```
① PUT  /admin/api/ctl/bundles    -- 修改 bundle_state 为 OFFLINE
   { "bundle_ids": ["xxx"], "bundle_state": "OFFLINE" }
```

### 8.3 手动售罄/恢复

```
-- 手动售罄
PUT  /admin/api/ctl/bundles
{ "bundle_ids": ["xxx"], "static_sold_out": true }

-- 恢复售卖
PUT  /admin/api/ctl/bundles
{ "bundle_ids": ["xxx"], "static_sold_out": false }
```

### 8.4 修改每日限量

```
PUT  /admin/api/ctl/bundles
{
    "bundle_ids": ["xxx"],
    "bundle_sales_available_count": 200,
    "bundle_sales_total_count": 200
}
```
