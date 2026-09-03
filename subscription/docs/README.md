# 订阅与权益服务

`subscription` 拥有套餐、当前订阅、续费和权益状态；支付动作由 `payment`/`trade` 发起并通过内部 contract 应用结果。

## 权威入口

- [服务说明](../README.md)、[Agent 约束](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- API 真源：`../api/openapi.yaml`
- [订阅与权益领域](../../docs/engineering/domains/subscription-entitlements.md)

## 关键边界

订阅状态、Pass 和配额必须来自服务 contract，不从前端展示或订单名称反推。migration/seed 不属于应用启动和 service-local 正式发布路径。

## 验证

运行 `go test ./...`，覆盖创建/查询订阅、支付结果幂等应用、续费、过期和配额边界；跨服务修改按购买续费 Journey 端到端验证。
