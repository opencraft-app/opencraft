# 积分包前后端联调文档

> 更新时间：2026-09-11
>
> 后端服务：Credit、Trade
>
> 用户入口：通过 `service-gateway` 访问 `/v1/credit/*`

本文只说明控制台需要接入的积分包商品查询、询价、下单、支付和积分包查询。退款、计费回调、用量上报及生命周期任务不属于前端接入范围。

## 1. 接入约定

- 除支付中转页调用的 `POST /v1/credit/packages/order-url` 外，所有接口都需要登录，并受 service-gateway 实名门禁保护。
- 浏览器按现有登录态请求 service-gateway；`X-User-Id` 由网关注入，前端不得自行传用户 ID。支付中转页没有主站会话时，使用下单接口签发的 `auth_code` 鉴权。
- `auth_code` 有效期为 10 分钟，只能使用一次，并且只允许查询它绑定的 `dealName`。
- 示例中的 `<BASE_URL>` 替换为当前站点 API 地址，`<SESSION_COOKIE>` 替换为当前登录会话 Cookie。
- 积分包允许重复购买。每次购买成功后生成独立积分包，查询接口会逐条返回。
- 当前商品的真实周期为 `1m`。询价和下单都显式传 `time_span=1`、`time_unit=m`。
- 控制台禁止调用 `/v1/credit/packages/order-and-pay`。该接口只用于内部联调和自动化测试。

## 2. 购买流程

```text
GET  /v1/credit/products
  -> POST /v1/credit/inquiry
  -> POST /v1/credit/packages/order
  -> POST /v1/credit/packages/order-url
  -> 跳转支付页
  -> GET /v1/credit/packages
```

1. 页面加载时查询在线积分包商品。
2. 用户选择商品后发起询价，以 `real_total_cost` 展示实际应付金额。
3. 用户确认购买后调用下单接口，保存响应中的 `dealName` 和 `auth_code`。
4. 打开支付中转页，将 `dealName` 映射为 `deal_name`，并携带 `auth_code` 调用支付链接接口。中转页不依赖主站 Cookie。
5. `need_charge=1` 时跳转 `pay_url`；`need_charge=0` 时直接进入支付完成后的刷新流程。
6. 用户完成支付并返回控制台后，重新查询积分包。计费回调创建资源存在短暂延迟，未查到新增积分包时展示“处理中”并允许刷新。

## 3. 接口列表

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/v1/credit/products` | 查询可购买的积分包商品 |
| `POST` | `/v1/credit/inquiry` | 查询商品实际价格 |
| `POST` | `/v1/credit/packages/order` | 创建待支付订单 |
| `POST` | `/v1/credit/packages/order-url` | 获取已创建订单的支付链接 |
| `GET` | `/v1/credit/packages` | 查询当前用户的可用积分包 |

## 4. 查询商品

### `GET /v1/credit/products`

请求示例：

```bash
curl '<BASE_URL>/v1/credit/products' \
  -H 'Cookie: <SESSION_COOKIE>'
```

响应示例：

```json
{
  "success": true,
  "data": [
    {
      "product_id": "credit_1000",
      "product_name": "1000积分",
      "llm_gateway_plan_id": "<plan-id>",
      "state": "ONLINE",
      "created_time": "2026-09-10T02:00:00Z",
      "updated_time": "2026-09-10T02:00:00Z"
    }
  ]
}
```

前端只需要使用 `product_id`、`product_name` 和 `state`。当前在线商品为 `credit_1000`、`credit_2000`、`credit_4000`、`credit_8000`、`credit_12000`，对应 1000、2000、4000、8000、12000 积分。

## 5. 询价

### `POST /v1/credit/inquiry`

请求示例：

```bash
curl -X POST '<BASE_URL>/v1/credit/inquiry' \
  -H 'Content-Type: application/json' \
  -H 'Cookie: <SESSION_COOKIE>' \
  --data '{
    "product_id": "credit_1000",
    "time_span": 1,
    "time_unit": "m"
  }'
```

响应示例：

```json
{
  "product_id": "credit_1000",
  "price": "1000",
  "total_cost": "1000",
  "real_total_cost": "1000",
  "currency": "CNY",
  "discount": 0,
  "goods_num": 1,
  "product_code": "p_lighthouse",
  "sub_product_code": "sp_lighthouse_lv_credit_pkg",
  "pid": 1060881
}
```

金额字段沿用现有计费接口的最小货币单位。前端展示价格时优先使用 `real_total_cost`，并根据 `currency` 格式化；`price`、`total_cost` 可用于展示原价，其他字段无需展示。

## 6. 创建订单

### `POST /v1/credit/packages/order`

请求中的商品和周期必须与询价一致。

```bash
curl -X POST '<BASE_URL>/v1/credit/packages/order' \
  -H 'Content-Type: application/json' \
  -H 'Cookie: <SESSION_COOKIE>' \
  --data '{
    "product_id": "credit_1000",
    "time_span": 1,
    "time_unit": "m"
  }'
```

响应示例：

```json
{
  "dealName": "202609100000000001",
  "bigOrderId": "2026091000000000001",
  "auth_code": "550e8400-e29b-41d4-a716-446655440000"
}
```

`dealName` 和 `auth_code` 是支付中转页下一步获取支付链接所需的参数。注意：本接口响应中的订单号使用 camelCase，下一步请求字段使用 snake_case 的 `deal_name`。`auth_code` 签发失败时可能为空，此时仍可在保留主站登录态的页面调用支付链接接口。

## 7. 获取支付链接

### `POST /v1/credit/packages/order-url`

支付中转页无主站会话时的请求示例：

```bash
curl -X POST '<BASE_URL>/v1/credit/packages/order-url' \
  -H 'Content-Type: application/json' \
  --data '{
    "deal_name": "202609100000000001",
    "auth_code": "550e8400-e29b-41d4-a716-446655440000",
    "platform": "pc",
    "return_url": "https://lightvela.com/console/credits?payment=success",
    "cancel_url": "https://lightvela.com/console/credits?payment=cancelled"
  }'
```

仍处于主站登录态时也可以直接调用，后端优先使用网关注入的用户身份，并且不会消费请求中携带的 `auth_code`：

```bash
curl -X POST '<BASE_URL>/v1/credit/packages/order-url' \
  -H 'Content-Type: application/json' \
  -H 'Cookie: <SESSION_COOKIE>' \
  --data '{
    "deal_name": "202609100000000001",
    "platform": "pc"
  }'
```

请求字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `deal_name` | string | 是 | 下单接口返回的 `dealName` |
| `auth_code` | string | 条件必填 | 支付中转页没有主站会话时必填；10 分钟内一次性有效 |
| `platform` | string | 否 | 支付终端，PC 控制台传 `pc` |
| `wx_open_id` | string | 否 | 微信内支付场景使用 |
| `return_url` | string | 否 | 支付完成后的前端回跳地址 |
| `cancel_url` | string | 否 | 取消支付后的前端回跳地址 |

响应示例：

```json
{
  "deal_name": "202609100000000001",
  "pay_url": "https://buy.cloud.tencent.com/credit-checkout",
  "token_id": "midas-token-id",
  "order_id": "midas-order-id",
  "midas_app_id": "midas-app-id",
  "need_charge": 1,
  "uin": "700000000000",
  "app_id": "250000000"
}
```

- `need_charge=1`：跳转 `pay_url` 完成支付。
- `need_charge=0`：无需再次支付，直接刷新积分包列表。
- `token_id`、`order_id`、`midas_app_id`、`uin`、`app_id` 是支付组件可能使用的辅助字段，未返回时前端应兼容。
- 匿名请求开始校验后票据即被消费。即使 `deal_name` 不匹配或后续订单查询失败，也必须重新下单获取新票据，不能重放原 `auth_code`。
- 后端会校验订单属于当前登录用户且资源类型为积分包。订单不存在、归属不匹配或订单类型不匹配都返回 HTTP `404`。

## 8. 查询积分包

### `GET /v1/credit/packages`

请求示例：

```bash
curl '<BASE_URL>/v1/credit/packages' \
  -H 'Cookie: <SESSION_COOKIE>'
```

响应示例：

```json
{
  "credits": [
    {
      "credit_type": "paid",
      "credit_total": 1000.0000,
      "credit_available": 998.2500,
      "expired_time": "2026-10-10T02:00:00Z"
    },
    {
      "credit_type": "paid",
      "credit_total": 2000.0000,
      "credit_available": 2000.0000,
      "expired_time": "2026-10-10T03:00:00Z"
    }
  ]
}
```

字段说明：

| 字段 | 类型 | 说明 |
|---|---|---|
| `credit_type` | string | 积分类型；付费积分包为 `paid`，免费积分为 `free` |
| `credit_total` | number | 此积分包的总积分，最多四位小数 |
| `credit_available` | number | 此积分包当前可用积分，最多四位小数 |
| `expired_time` | string | RFC3339 格式的到期时间 |

接口不返回 `package_id`、`product_id`、`product_name`、`credit_used` 或 `status`。已到期、隔离中或已销毁的积分包不会返回。

## 9. 通用错误处理

错误响应格式：

```json
{
  "success": false,
  "message": "order not found",
  "code": "404"
}
```

| HTTP 状态码 | 前端处理建议 |
|---|---|
| `400` | 请求参数错误，阻止继续支付并提示重新操作 |
| `401` | 登录态缺失，或 `auth_code` 不存在、过期、已使用；返回控制台重新下单 |
| `403` | `auth_code` 与 `deal_name` 不匹配；返回控制台重新下单 |
| `404` | 商品或订单不存在，返回商品页重新下单 |
| `409` | 商品已下线，刷新商品列表 |
| `500` | 支付票据服务暂不可用，保留页面状态并提示稍后重试 |
| `502` | 计费或下游服务暂不可用，保留页面状态并提示稍后重试 |
