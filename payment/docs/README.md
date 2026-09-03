# 支付服务

`payment` 拥有支付侧 HTTP contract 与回调处理；订阅权益最终状态由支付、订阅和交易链路共同完成。

## 权威入口

- [服务说明](../README.md)、[Agent 约束](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- API 真源：`../api/openapi.yaml`
- [订阅购买与续费 Journey](../../docs/engineering/journeys/subscription-purchase-renewal.md)

## 关键边界

migration 由仓库级 GitOps DB job 执行，不放进应用启动。外部支付规则和实时配置属于登记的外部 authority；文档不保存凭据或复制易漂移字段。

## 验证

运行 `go test ./...` 并覆盖回调签名、幂等、重复通知、失败恢复和权益应用；发布验收另核对 migration、镜像与 Argo。
