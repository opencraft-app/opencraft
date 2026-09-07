# 订阅与权益领域

本领域覆盖套餐、订阅、Pass、配额、订单、支付、续费与外部计费。它由多个服务分阶段拥有，不能用一个前端字段或单张订单表代表完整状态。

## 服务与责任

| 服务 | 责任 |
|---|---|
| `subscription` | 套餐、当前订阅、续费和权益应用 |
| `payment` | 支付链接/回调 contract 与支付侧幂等 |
| `trade` | 订单、计费 provider 和成功后的开通编排 |
| `cloudladdergateway` | 到 IDC/计费上游的强认证代理与审计 |
| `ctl` | 在商业 contract 成功后执行实例/能力开通 |

## 稳定不变量

- 支付成功、订单成功和权益生效是不同阶段，必须分别建模和验证。
- 回调、权益应用和开通都必须幂等；失败补偿不能重复创建外部资源。
- 外部计费入向回调按产品类型隔离地域 route：Pass 使用 `jifei-callback-{region}`，Credit 使用 `jifei-credit-callback-{region}`；调整 Credit 的环境落点不能改变 Pass 路由。
- 只有 provider 成功创建 contract 后才能调用 CTL 开通。
- 外部计费价格、活动和 API 规则属于外部 authority，不从历史文档直接采用。
- 前端只呈现服务返回的订阅/配额状态，不能成为唯一门禁。

## 机器契约与验证

API 真源包括 `subscription/api/openapi.yaml` 与 `payment/api/openapi.yaml`，交易行为由 `trade` 源码/测试证明。验证覆盖重复回调、延迟回调、续费、过期、配额边界、provider/CTL 分段失败和恢复。

相关 Journey：[订阅购买与续费](../journeys/subscription-purchase-renewal.md)。Agent 摘要：[subscription-entitlements Context](../../context/domains/subscription-entitlements.md)。
