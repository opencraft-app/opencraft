---
id: service-gateway-service-context
type: service
scope: 公共网关、站点路由、鉴权和后端代理的派生服务上下文。
triggers: ["service-gateway", "公共网关", "gateway route"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - service-gateway/docs/README.md
  - service-gateway/catalog-info.yaml
status: active
reviewed_at: 2026-08-26
review_due: 2026-11-24
revision: 1.0.0
precedence: service
derived: true
related_packs: ["identity-access", "agent-gateway-runtime", "site-environment-routing", "release-gitops"]
---

# Service Gateway 服务 Context

- 公共路径成功不能用后端直连替代，路由变更必须覆盖目标站点和失败传播。
- 网关消费身份/实名/权益状态，不拥有这些业务事实。
- `admin-gateway` 发布独立；不得通过本服务流水线夹带管理面更新。
