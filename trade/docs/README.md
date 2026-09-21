# 交易与商业计费集成

`trade` 编排订单、外部计费 provider、支付回调和开通；它不重新定义订阅权益，也不拥有外部计费规则。

## 权威入口

- [服务说明](../README.md)、[Agent 约束](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- [订阅购买与续费 Journey](../../docs/engineering/journeys/subscription-purchase-renewal.md)
- 外部事实边界：`../../.agents/context/external-sources.yaml`

## 核心不变量

回调和开通必须幂等；只有 provider 成功创建 contract 后才能调用 CTL。保留既有外部用户/订单标识，不能建立平行身份映射。

## 验证

运行 `go test ./...` 与 `go vet ./...`，覆盖重复回调、provider 失败、开通失败补偿和已有订单兼容；真实外部调用需单独授权。
