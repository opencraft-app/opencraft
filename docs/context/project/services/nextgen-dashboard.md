---
id: nextgen-dashboard-service-context
type: service
scope: 下一代管理 Dashboard 服务与独立 GitOps 发布的派生服务上下文。
triggers: ["nextgen-dashboard", "nextgen dashboard", "下一代管理台"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - nextgen-dashboard/docs/README.md
  - nextgen-dashboard/catalog-info.yaml
status: active
reviewed_at: 2026-08-26
review_due: 2026-11-24
revision: 1.0.0
precedence: service
derived: true
related_packs: ["agent-gateway-runtime", "release-gitops"]
---

# Nextgen Dashboard 服务 Context

- 管理 API 与发布责任独立于 `gateway-dashboard`。
- runtime Secret 走 `SSM → sops → ksops`，`generated/` 不提交。
- 验证 Go 服务、管理 API、镜像 pin 和独立 Argo revision。
