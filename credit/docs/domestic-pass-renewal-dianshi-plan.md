# 国内站 Pass 续费接入点石方案

> 状态：已实现，待 MR
> 日期：2026-09-23
> 范围：国内站 Pass 续费；国际站不在本期范围内

## 1. 背景

国内站 Pass 新购已经接入点石，续费仍统一走计费。此次需要为续费补齐两种点石能力：

1. 控制台普通续费：每个用户在续费活动中只能享受一次点石优惠。
2. 内部下单并支付：允许受信任的内部调用方不限次数使用点石续费优惠。

本文放在 `credit/docs/` 作为计费域方案记录，但实现边界仍属于 CTL 和 Trade。Credit 服务不提供
Pass 续费能力，本期不修改 Credit API、数据模型、worker 或部署配置。

## 2. 已确认现状

### 2.1 ExternalUserId

Cloud API `DescribePass` 已支持返回：

```text
Response.Pass.ExternalUserId
```

点石可以根据续费请求中的 `resourceId` 回调 CTL 查询 Pass，并从 `DescribePass` 响应获取
`ExternalUserId` 及其他资源信息。因此，续费询价和下单不需要在 `preference_param` 中重复传入
影子账号信息。

### 2.2 续费下单并支付接口使用情况

当前代码已有续费下单并支付能力：

```text
CTL:
POST /v1/passes/{pass_id}/renew/order-and-pay
POST /admin/api/ctl/passes/{pass_id}/renew/order-and-pay

Trade:
POST /internal/trade/orders/renew/place-and-pay
```

核查结果：

- 前端仅有接口封装，没有页面业务调用。
- 上海现网当前可观测日志窗口内没有续费 `order-and-pay` 的实际请求。
- 现网普通续费使用 `/renew/order` 和 `/renew/order-url` 两段式链路。
- Trade 接口本身是内部接口，受内部 token 保护。

现有续费 `order-and-pay` 是计费链路。其 Trade 内部接口和语义必须保持不变，现有 CTL 公网及
管理端入口取消。点石续费只新增独立的 Trade 内部入口，避免将现有计费能力替换为点石能力，也
避免在 CTL 再暴露一层转发入口。

当前新购已有独立点石下单并支付链路：

```text
CTL:   CreateDianshiPassOrderAndPay
Trade: PlaceDianshiOrderAndPay
API:   POST /internal/trade/dianshi/orders/place-and-pay
```

该链路可以作为续费点石实现的参考，包括点石客户端调用、请求签名、响应校验、订单幂等和同步回调
早于订单落库的兼容处理；但新购和续费的资源、订单及回调语义不同，不能直接复用新购业务方法。

## 3. 目标与非目标

### 3.1 目标

- 国内站控制台续费支持点石询价和下单。
- 控制台续费活动限制为每个用户参与一次。
- 新购活动和续费活动资格相互独立。
- 提供仅内部可调用的点石续费下单并支付入口，并允许不限次数调用。
- 点石询价、下单和下单并支付使用统一且最小化的 `preference_param`。
- 保持现有国际站续费行为不变。

### 3.2 非目标

- 本期不接入国际站点石续费。
- 不修改 Pass 新购点石逻辑。
- 不修改现有 Trade 计费续费 `order-and-pay` 的接口或行为。
- 不修改 Credit 服务运行时代码。
- 不新增公网的点石下单并支付接口。
- 不允许续费时更换 Bundle。

## 4. 数据模型与活动配置

### 4.1 场景枚举

活动映射和参与记录统一增加 `scene` 字段，当前只允许以下值：

| 值 | 含义 |
| --- | --- |
| `purchase` | Pass 新购活动 |
| `renew` | Pass 续费活动 |

业务代码不得用 `activity_id` 是否相同来推断场景。所有活动映射查询、参与资格查询和参与记录写入都
必须显式传入 `scene`。

### 4.2 `trade_bundle_activity`

当前表以 `bundle_id` 单列唯一，无法为同一个 Bundle 同时配置新购和续费活动。新增 migration：

```sql
ALTER TABLE trade_bundle_activity
    ADD COLUMN scene VARCHAR(16) NOT NULL DEFAULT 'purchase'
        COMMENT '活动场景：purchase=新购，renew=续费'
        AFTER bundle_id,
    DROP INDEX bundle_id,
    ADD UNIQUE KEY uk_bundle_scene (bundle_id, scene),
    ADD KEY idx_scene_activity (scene, activity_id, active);
```

兼容策略：

- 存量行通过默认值全部回填为 `purchase`，现有新购活动行为不变。
- `GetBundleActivityByBundleID` 调整为按 `(bundle_id, scene)` 查询，并更名为能体现 scene 的接口。
- `BundleActivity`、`activity.Mapping` 和后台查询 DTO 增加 `Scene`。
- 现有 seed 必须显式写入 `scene='purchase'`，避免后续依赖默认值。
- 国内续费按目标 Bundle 新增 `scene='renew'` 的活动行，不覆盖新购行。

国内站续费活动行使用：

| 字段 | 值 |
| --- | --- |
| `scene` | `renew` |
| `activity_id` | `166165503931688` |
| `act_id` | `1975812517099088` |

`bundle_id`、`secret_key`、`time_span_unit`、`order_expired_time` 和 `active` 按各环境实际活动配置
写入。上海 seed 当前为 `bundle_launch_01` 增加 renew 行，密钥仍通过 SQL session variable 注入。
活动 ID 不在 Go 代码中硬编码，以数据库活动参数表为真源。

### 4.3 `trade_user_activity_participation`

参与记录新增 `scene`，并调整唯一键：

```sql
ALTER TABLE trade_user_activity_participation
    ADD COLUMN scene VARCHAR(16) NOT NULL DEFAULT 'purchase'
        COMMENT '活动场景：purchase=新购，renew=续费'
        AFTER activity_id,
    DROP INDEX uk_uin_activity,
    ADD UNIQUE KEY uk_uin_activity_scene (uin, activity_id, scene),
    DROP INDEX idx_external_user,
    ADD KEY idx_external_user_scene (external_user_id, activity_id, scene);
```

兼容策略：

- 存量参与记录通过默认值全部回填为 `purchase`。
- `UserActivityParticipation` 和后台查询 DTO 增加 `Scene`。
- `HasUserParticipated` 调整为按 `(uin, activity_id, scene)` 查询。
- `InsertUserParticipation` 必须显式写入 `scene`。
- 后台参与记录列表支持按 `scene` 筛选和展示。

唯一键不包含 `bundle_id`，活动资格语义仍是“每个 UIN 在同一活动、同一场景只能参与一次”，不能
通过购买另一个 Bundle 再次参与。同一个 `activity_id` 即使同时用于新购和续费，也会因为 `scene`
不同而各有一次资格。

### 4.4 `trade_order` 复用索引

点石订单复用查询必须加入 `order_type` 条件，防止同 Bundle、同活动 ID 下误把新购订单复用为续费
订单。调整现有复用索引：

```sql
ALTER TABLE trade_order
    DROP INDEX idx_dianshi_reusable_order,
    ADD INDEX idx_dianshi_reusable_order
        (external_user_id, activity_id, order_type, bundle_id, source, status, created_time);
```

`FindReusableDianshiOrder` 同步增加 `order_type` 入参。新购固定查询 `create`，续费固定查询 `renew`。

### 4.5 参与记录写入时机

- 新购：`createResource` 成功后写 `scene='purchase'`，保持现有语义。
- 控制台续费：点石 `do_goods_renew` 成功返回后，在同一个数据库事务中创建 `trade_order` 并写入
  `scene='renew'` 的参与记录。
- 内部无限次续费：只创建 `trade_order`，不调用参与记录写入逻辑。
- 参与记录唯一键冲突按幂等成功处理。
- 订单或参与记录任一写入失败时回滚整个本地事务并返回错误，不能出现“有续费订单但缺参与记录”
  的本地状态。

控制台资格按“成功创建点石续费订单”消耗，而不是等支付或履约后再消耗。这与“控制台续费下单每
用户每活动只能参与一次”的要求一致，也避免依赖 `renewResource` 回调时序。重复点击优先复用有效
期内的原订单；确需让已过期且未支付的订单重新参加时，通过现有点石后台管理能力清理对应订单和
`scene='renew'` 参与记录后重试。

## 5. 总体架构

```text
控制台普通续费
Frontend
  -> CTL 续费询价/下单
  -> Trade 判断国内站续费活动资格
     -> 首次参与：Dianshi get_price_renew / do_goods_renew
     -> 已参与：现有计费询价/下单

内部无限次续费
Internal Caller
  -> Trade internal dianshi/orders/renew/place-and-pay
  -> Trade 校验 internal token、站点及请求参数
  -> Dianshi do_goods_renew (auto_pay="1")

现有计费续费
Trusted Internal Caller
  -> Trade /internal/trade/orders/renew/place-and-pay
  -> Jifei existing place-and-pay flow（保持不变）
```

Trade 继续负责外部商品协议、点石调用、订单记录和回调适配。CTL 只承载控制台普通续费入口；无限
次点石续费由受信任调用方直接访问 Trade 内部接口。

## 6. 控制台普通续费

### 6.1 询价

保留现有控制台续费询价入口和请求协议。

Trade 在国内站执行以下分流：

1. 校验 Pass、Bundle、续费周期和影子账号。
2. 按 `(bundle_id, scene='renew')` 读取续费活动参数。
3. 按 `(uin, activity_id, scene='renew')` 查询用户是否参与过续费活动。
4. 未参与时调用点石询价。
5. 已参与时走现有计费询价。
6. 没有 `scene='renew'` 活动配置、活动未启用或活动资格查询异常时，回落现有计费询价，
   避免代码先于活动配置发布时影响存量续费。

国际站不执行活动判断，继续走现有计费询价。

### 6.2 下单

保留现有控制台续费下单入口：

```text
POST /v1/passes/{pass_id}/renew/order
```

请求体保持不变：

```json
{
  "period": 1,
  "time_unit": "m"
}
```

国内站下单时重新校验活动资格：

- 未参与：调用点石 `do_goods_renew`，创建待支付续费订单。
- 已参与：调用现有计费续费下单。
- 点石 `do_goods_renew` 成功后，在同一数据库事务中落续费订单和 `scene='renew'` 参与记录。
- 点石下单失败时不产生已参与事实；支付或履约失败不自动释放已经创建订单所消耗的活动资格。
- 没有 `scene='renew'` 活动配置、活动未启用或活动查询失败时，普通续费下单走原计费
  `GenerateDeals`；点石专用内部接口仍要求有效活动配置，不回退到计费。

参与记录必须依赖数据库唯一约束和订单幂等，防止并发请求重复享受控制台续费活动。

## 7. 内部续费下单并支付

### 7.1 Trade 内部实现

保留现有计费接口及实现，不做行为修改：

```text
POST /internal/trade/orders/renew/place-and-pay
```

新增点石续费专用接口：

```text
POST /internal/trade/dianshi/orders/renew/place-and-pay
```

新增 `PlaceDianshiRenewOrderAndPay` 业务方法，参考新购 `PlaceDianshiOrderAndPay` 的基础能力，但使用
续费语义独立实现：

- 不查询控制台续费活动参与记录。
- 不写入控制台续费活动参与记录。
- 允许受信任的内部调用方不限次数续费。
- 调用点石 `do_goods_renew`，并传 `auto_pay="1"`；不调用新购的 `do_goods_and_pay`。
- 订单使用 `order_type=renew`、`resource_type=pass` 和目标 `pass_id`。
- 不调用参与记录写入逻辑，明确绕过控制台活动资格。
- 复用现有续费资源校验及 `checkRenew/renewResource` 回调处理。
- 参考新购点石下单并支付对“同步回调早于订单落库”的兼容方案，但使用续费 flow 和续费订单字段。

国际站继续保持现有逻辑，本期不切换点石。点石续费专用接口在国际站收到请求时返回明确的
`UnsupportedSite`，且不得调用点石。

### 7.2 现有计费入口处理

取消以下 CTL 公网及管理端路由，使其返回 `404`：

```text
POST /v1/passes/{pass_id}/renew/order-and-pay
POST /admin/api/ctl/passes/{pass_id}/renew/order-and-pay
```

只保留现有 Trade 计费内部接口，并保持其协议和行为不变：

```text
POST /internal/trade/orders/renew/place-and-pay
```

原计费和点石 `order-and-pay` 后续都只能由受信任的内部调用方直接调用 Trade。CTL 不注册对应的
公网、管理端或 internal 转发路由。不得为任何续费下单并支付能力增加 `/v1` 或 `/admin/api`
路由，避免公网用户绕过“每用户每活动一次”的限制。

## 8. 点石请求协议

续费询价和下单分别调用 `POST /activity_web/activity/get_price_renew` 与
`POST /activity_web/activity/do_goods_renew`。控制台下单不传 `auto_pay`，内部下单并支付
在同一个 `do_goods_renew` 请求中传 `auto_pay="1"`。两者均使用 `goods_renew` 数组，
商品字段直接放在数组元素中：

```json
{
  "goods_id": 1975812517099088,
  "regionId": 1,
  "resourceId": "pass-xxxx",
  "timeSpanUnit": "1m",
  "bundleId": "bundle_launch_01"
}
```

字段说明：

| 字段 | 来源 |
| --- | --- |
| `regionId` | Trade 当前计费地域配置 |
| `resourceId` | path 中的目标 Pass ID |
| `timeSpanUnit` | `period + time_unit`，例如 `1m` |
| `bundleId` | CTL 从目标 Pass 读取的 Bundle ID |
| `goods_id` | 续费活动商品 ID (`act_id`) |

不得额外传入以下字段：

- `externalUserId`
- `subProductCode`
- `curDeadline`
- `dianshiActId`
- 其他未在本节声明的字段

点石通过 `resourceId` 调用 Cloud API `DescribePass` 获取资源详情。

## 9. 订单与活动语义

### 9.1 控制台 `do_goods_renew`

- `source = dianshi`
- `order_type = renew`
- `resource_type = pass`
- `resource_id = pass_id`
- 初始订单状态为待支付状态
- 订单与 `scene=renew` 参与记录在同一数据库事务内写入

### 9.2 内部 `do_goods_renew` (`auto_pay="1"`)

- 使用相同的续费订单字段。
- 同步成功并返回资源结果后，按现有下单并支付语义推进订单状态。
- 不消耗控制台活动资格。
- 该入口允许内部任务有意重复续费；调用方应在任务层提供自己的请求幂等控制。

## 10. 安全约束

- CTL 的公网、管理端和 internal 路由均不能访问点石续费下单并支付能力。
- 原计费及新增点石 Trade 内部接口都必须校验内部 token；token 未配置、缺失或错误时拒绝请求。
- 点石 Trade 内部接口只接受国内站请求，并校验影子账号、Bundle、周期及必填资源参数。
- 受信任调用方必须使用目标 Pass 当前的 Bundle，不得把该入口转发给不受信任请求方。
- 国内站和国际站必须通过明确的站点配置分流，不能通过请求参数切换。

## 11. 失败与降级策略

| 场景 | 控制台普通续费 | 内部下单并支付 |
| --- | --- | --- |
| 活动资格查询失败 | 回落现有计费 | 不查询活动资格 |
| 续费活动未配置或未启用 | 询价、下单均走现有计费 | 点石专用接口返回活动未配置错误 |
| 用户已参加续费活动 | 回落现有计费 | 不受影响 |
| 点石询价失败 | 返回明确上游错误 | 不适用 |
| 点石下单失败 | 返回失败且不消耗资格 | 返回失败 |
| Pass 不属于用户 | 拒绝 | 由受信任调用方在调用 Trade 前校验 |
| internal token 缺失或错误 | 不适用 | Trade 拒绝 |
| 国际站请求 | 保持现有计费 | 点石专用接口返回 `UnsupportedSite`；原计费接口不变 |

## 12. 代码影响范围

预计涉及：

### CTL

- `ctl/main/api/`：移除公网和管理端续费 `order-and-pay` 路由分发；不新增 internal 转发路由；
  管理查询支持按 `scene` 筛选。
- `ctl/pkg/adapter/trade/`：透传管理查询的 `scene` 参数和参与记录响应字段。

### Trade

- `trade/migrations/`：为活动映射和参与记录补齐场景字段，调整唯一键及点石订单复用索引。
- `trade/internal/logic/activity/`：按 `bundle_id + scene` 解析活动，并按
  `uin + activity_id + scene` 判断资格。
- `trade/internal/logic/inquiry/`：续费询价点石分流。
- `trade/internal/logic/placeorder/`：控制台续费 `do_goods_renew` 分流；新增独立的点石续费
  下单并支付方法，通过同一接口的 `auto_pay="1"` 实现，不复用新购业务语义。
- `trade/internal/httpapi/internalapi/`：新增点石续费专用内部路由，保留现有计费续费路由。
- `trade/internal/store/`：补齐带 scene 的活动 DAO，并提供续费订单与参与记录的事务写入能力。
- `trade/internal/logic/createresource/`：新购参与记录显式写 `scene=purchase`。
- `trade/cmd/trade/`：组装续费活动依赖。

### Credit

- 仅新增本文档，不修改运行时代码。

## 13. 测试清单

### 13.1 Trade

- 国内用户首次续费询价走点石，并校验 `goods_renew` 仅有商品 ID 和四个指定业务字段。
- 同一 Bundle 可同时读取 `purchase` 和 `renew` 两条活动配置，互不覆盖。
- 存量活动映射和参与记录迁移后均为 `scene=purchase`。
- 国内用户已参加续费活动时询价回落计费。
- 活动资格查询异常时询价回落计费。
- 续费活动未配置或查询失败时，普通询价与下单均回落计费，且不调用点石。
- 国内首次控制台续费下单调用 `do_goods_renew` 并记录参与信息。
- 点石下单失败不记录参与信息。
- 并发或重复请求不重复消耗活动资格、不生成非预期重复订单。
- 内部续费下单并支付调用 `do_goods_renew` 且传 `auto_pay="1"`，不读写参与记录。
- 新购参与记录写 `scene=purchase`，续费参与记录写 `scene=renew`。
- 同一 UIN、同一 activity ID 在 `purchase` 和 `renew` 场景可各有一条参与记录。
- 同一 UIN、activity ID 和 scene 的重复写入按唯一键幂等处理。
- 续费订单与 `scene=renew` 参与记录原子写入，不能只成功一项。
- 内部无限次续费不写入 `scene=renew` 参与记录。
- 新增点石续费路由和原计费续费路由分别调用各自实现，互不分流。
- 原 `/internal/trade/orders/renew/place-and-pay` 继续调用计费，不调用点石。
- 国际站调用点石续费专用接口返回 `UnsupportedSite`，且点石客户端调用次数为 0。
- 国际站续费询价、下单和下单并支付保持现有行为。

### 13.2 CTL

- 公网用户及管理端旧 `renew/order-and-pay` 路径返回 `404`。
- CTL internal 不存在点石续费下单并支付转发路由。
- 管理查询能够按 `purchase/renew` 筛选并保留参与记录的 `scene` 字段。
- 普通 `/renew/order` 和 `/renew/order-url` 行为不回归。

### 13.3 联调

- 点石续费询价和 `do_goods_renew` 的请求级 `preview` 固定为 `1`；新购不设置请求级
  preview，保持现有全局 `DIANSHI_PREVIEW` 行为。
- 一个从未参与续费活动的国内用户完成点石询价、下单、支付及续费回调。
- 同一用户第二次控制台续费回落现有计费。
- 同一用户仍可由受信任调用方直接调用 Trade 内部接口，多次执行点石下单并支付。
- 新购活动参与记录不影响续费活动资格。
- 点石按 `resourceId` 回调 `DescribePass` 后能读取 `ExternalUserId`。

## 14. 发布与回滚

建议发布顺序：

1. 先发布 Trade migration，完成存量 `scene=purchase` 回填、唯一键和索引调整。
2. 此时不要插入 `scene=renew` 行；旧 Trade 仍按 `bundle_id` 单列查询，多行会造成配置读取不确定。
3. 发布支持 scene 的 Trade 代码，保留现有计费回退能力。
4. 验证现有新购点石链路明确读取 `scene=purchase`，并验证原计费续费 `place-and-pay` 行为未变化。
5. 导入各 Bundle 的 `scene=renew` 活动参数，初始保持 `active=0`。
6. 发布 CTL，取消现有公网及管理端 `order-and-pay` 入口；不增加 internal 转发入口。
7. 验证普通续费计费回退路径。
8. 将测试 Bundle 的续费活动配置切为 `active=1`，验证一次控制台点石续费。
9. 验证新购和续费参与记录 scene 正确且资格相互独立。
10. 验证 Trade 内部点石下单并支付的 token、重复调用及不写参与记录。

回滚时优先关闭 Trade 的续费点石分流，使控制台恢复现有计费续费；CTL 仅需恢复旧路由版本。
活动参与记录保留，不做数据删除，避免回滚和再次发布后重复发放优惠资格。

若需要回滚到不识别 `scene` 的旧 Trade 版本，必须先备份并删除 `trade_bundle_activity` 中所有
`scene='renew'` 行，确保每个 `bundle_id` 只剩一条 `purchase` 行，否则旧代码按 `bundle_id` 查询会
产生不确定结果。常规应用回滚不执行 down migration；只有明确接受删除续费配置及续费参与记录时，
才能恢复旧唯一键并删除 `scene` 列。

## 15. 验收标准

- 国内站首次控制台续费可享受点石活动，第二次不再享受。
- 新购和续费各自拥有一次独立活动资格。
- 活动参数和参与记录均以 `scene` 明确区分新购与续费，不依赖活动 ID 碰巧不同。
- 内部调用方可以通过 Trade 内部接口安全地执行不限次数点石续费。
- 现有 Trade 计费续费 `order-and-pay` 接口和行为保持不变。
- CTL 公网及管理端旧续费 `order-and-pay` 路径返回 `404`。
- 公网无法调用点石续费下单并支付能力。
- 点石请求只包含约定的四个 `preference_param` 字段。
- 国际站和现有普通计费续费链路无行为变化。
