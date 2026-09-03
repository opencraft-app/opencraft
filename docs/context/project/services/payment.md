---
id: payment-service-context
type: service
scope: 支付链接、回调、幂等和订阅权益衔接的派生服务上下文。
triggers: ["payment", "支付回调", "pay url"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - payment/docs/README.md
  - payment/catalog-info.yaml
status: active
reviewed_at: 2026-08-26
review_due: 2026-11-24
revision: 1.0.0
precedence: service
derived: true
related_packs: ["subscription-entitlements", "release-gitops"]
---

# Payment 服务 Context

- API 真源是 `payment/api/openapi.yaml`，支付成功不自动等同权益已生效。
- 回调必须验证签名和幂等，migration 不进入应用启动路径。
- 覆盖重复/延迟回调、错误恢复，并分别验证订阅应用与发布状态。
