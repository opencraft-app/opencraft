---
id: gateway-dashboard-service-context
type: service
scope: 网关管理前端、Admin Gateway 入口和发布边界的派生服务上下文。
triggers: ["gateway-dashboard", "网关管理台", "dashboard frontend"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - gateway-dashboard/docs/README.md
  - gateway-dashboard/catalog-info.yaml
status: active
reviewed_at: 2026-08-26
review_due: 2026-11-24
revision: 1.0.0
precedence: service
derived: true
related_packs: ["agent-gateway-runtime", "release-gitops"]
---

# Gateway Dashboard 服务 Context

- 公网入口经 `admin-gateway`，历史 direct-access 不是正式链路。
- UI 不拥有 provider/路由执行语义，必须消费后端 contract。
- 运行 package lint/type/test/build，并验证管理入口与独立 Argo 应用。
