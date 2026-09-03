---
id: subscription-service-context
type: service
scope: 套餐、订阅、续费、Pass 与配额状态的派生服务上下文。
triggers: ["subscription", "订阅服务", "entitlement quota"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - subscription/docs/README.md
  - subscription/catalog-info.yaml
status: active
reviewed_at: 2026-08-26
review_due: 2026-11-24
revision: 1.0.0
precedence: service
derived: true
related_packs: ["subscription-entitlements", "release-gitops"]
---

# Subscription 服务 Context

- 套餐、订阅、Pass 和配额来自服务 API/存储，不从 UI 或订单名推断。
- 支付结果应用必须幂等，migration/seed 不进入应用启动路径。
- 覆盖续费、过期、重复支付结果和配额边界。
