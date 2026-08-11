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
  "cancel_url": "https://intl-sandbox-kr-1.preview.lightclaw.tech/auth/wechat-pay",
  "return_url": "https://intl-sandbox-kr-1.preview.lightclaw.tech/auth/wechat-pay"
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
  "cancel_url": "https://intl-sandbox-kr-1.preview.lightclaw.tech/auth/wechat-pay",
  "return_url": "https://intl-sandbox-kr-1.preview.lightclaw.tech/auth/wechat-pay"
}
```

## 字段说明

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `deal_names` | `string[]` | 是 | 阶段一下单接口返回的计费订单号。当前前端传单元素数组。 |
| `platform` | `"pc" \| "mobile"` | 否 | 支付平台。微信中转页传 `mobile`，不传时后端沿用计费默认行为。 |
| `wx_open_id` | `string` | 微信支付场景是 | 微信公众号 `snsapi_base` 授权得到的 openid。 |
| `auth_code` | `string` | 中转页场景是 | CTL 阶段一下单返回的一次性 ticket；中转页无 Bearer 时用于鉴权。 |
| `cancel_url` | `string` | 国际站信用卡/签约支付是 | 用户取消支付后的前端回跳地址。CTL 只透传，trade 会映射为计费 `cancelUrl`。 |
| `return_url` | `string` | 国际站信用卡/签约支付是 | 用户完成支付后的前端回跳地址。CTL 只透传，trade 会映射为计费 `returnUrl`。 |

约束：

- `cancel_url` / `return_url` 必须是浏览器可访问的完整 HTTPS URL。测试环境本地单测可用 `http://localhost/...`，线上和预览环境不要传相对路径。
- 国内站可不传这两个字段；国际站信用卡/签约支付必须传，否则计费订单中心可能返回 `param cancelUrl invalid`。
- 前端传入这两个字段时，建议使用不包含 query/hash 的稳定页面地址，避免把 OAuth code、openid 或一次性 ticket 带入计费回跳地址。

## 后端透传关系

```text
frontend cancel_url / return_url
  -> ctl CreatePassOrderUrlRequest / RenewPassOrderUrlRequest
  -> ctl trade.GeneratePayURL options
  -> trade /internal/trade/orders/{dealName}/pay-url body
  -> jifei qcloud.margin.getMidasEarmarking cancelUrl / returnUrl
```
