# CTL 与前端计费联调协议

本文记录前端调用 CTL 计费接口时需要遵守的请求协议。字段名以公网 HTTP JSON 为准，后端会在 ctl -> trade -> jifei 链路中转换成计费协议字段。

## 支付 URL 接口

### 新购支付 URL

`POST /v1/passes/order-url`

```json
{
  "deal_names": ["20260810207021863965541"],
  "platform": "mobile",
  "wx_open_id": "o_xxx",
  "auth_code": "AC-xxx",
  "cancel_url": "https://sandbox-kr-1.lightclaw.tech/subscribe",
  "return_url": "https://sandbox-kr-1.lightclaw.tech/subscribe"
}
```

### 续费支付 URL

`POST /v1/passes/{pass_id}/renew/order-url`

```json
{
  "deal_names": ["20260810207021863965541"],
  "platform": "mobile",
  "wx_open_id": "o_xxx",
  "auth_code": "AC-xxx",
  "cancel_url": "https://sandbox-kr-1.lightclaw.tech/subscribe",
  "return_url": "https://sandbox-kr-1.lightclaw.tech/subscribe"
}
```

## 字段说明

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `deal_names` | `string[]` | 是 | 阶段一下单接口返回的计费订单号。当前前端传单元素数组。 |
| `platform` | `"pc" \| "mobile"` | 否 | 支付平台。微信中转页传 `mobile`，不传时后端沿用计费默认行为。 |
| `wx_open_id` | `string` | 微信支付场景是 | 微信公众号 `snsapi_base` 授权得到的 openid。 |
| `auth_code` | `string` | 中转页场景是 | CTL 阶段一下单返回的一次性 ticket；中转页无 Bearer 时用于鉴权。 |
| `cancel_url` | `string` | 否 | 用户取消支付后的前端回跳地址。CTL 只透传，trade 会映射为计费 `CancelUrl`；未传时使用环境兜底地址。 |
| `return_url` | `string` | 否 | 用户完成支付后的前端回跳地址。CTL 只透传，trade 会映射为计费 `ReturnUrl`；未传时使用环境兜底地址。 |

约束：

- `cancel_url` / `return_url` 必须是浏览器可访问的完整 HTTPS URL。测试环境本地单测可用 `http://localhost/...`，线上和预览环境不要传相对路径。
- 前端显式传入的地址优先；国际站任一字段未传时，trade 使用该环境的 `TRADE_BILLING_PAY_REDIRECT_URL` 补齐。KR 当前兜底为 `https://sandbox-kr-1.lightclaw.tech/subscribe`。
- 国内站不读取该兜底配置，继续保持原有支付链路。
- 前端传入这两个字段时，建议使用不包含 query/hash 的稳定页面地址，避免把 OAuth code、openid 或一次性 ticket 带入计费回跳地址。

## 国际站支付模式

- 新购和续费都通过计费云 API `CreatePayUrl` 获取支付链接。
- `auto_renew_flag` 只控制新购订单 `goodsDetail.autoRenewFlag`，与支付链接的 `ContractOrder` 完全解耦。
- 新购生成支付链接前，trade 会通过 auth 内部接口查询用户是否已有签约卡：未绑卡时传 `ContractOrder=1`，按签约并支付处理；已绑卡时不传 `ContractOrder`，直接使用现有卡支付。
- 查询绑卡状态失败时按未绑卡处理，回退为 `ContractOrder=1` 的签约并支付流程。
- 续费不查询绑卡状态，始终走纯支付，不传 `ContractOrder`，不会再次发起签约。
- 新购和续费均保持 `PayScene=credit_card`、`PayOption=chargePay`，并透传 `platform`、`cancel_url` 和 `return_url`；缺失的回跳地址由 trade 按环境配置补齐。

## 后端透传关系

```text
frontend cancel_url / return_url
  -> ctl CreatePassOrderUrlRequest / RenewPassOrderUrlRequest
  -> ctl trade.GeneratePayURL options
  -> trade /internal/trade/orders/{dealName}/pay-url body
  -> 国内站：jifei qcloud.margin.getMidasEarmarking cancelUrl / returnUrl
  -> 国际站：缺失字段使用 TRADE_BILLING_PAY_REDIRECT_URL
  -> 国际站：计费云 API CreatePayUrl CancelUrl / ReturnUrl
```
