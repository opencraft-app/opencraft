---
id: ai-gateway-service-context
type: service
scope: 模型网关、供应商适配、流式行为和独立发布边界的派生服务上下文。
triggers: ["ai-gateway", "模型网关", "provider adapter"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - ai-gateway/docs/README.md
  - ai-gateway/catalog-info.yaml
status: active
reviewed_at: 2026-08-26
review_due: 2026-11-24
revision: 1.0.0
precedence: service
derived: true
related_packs: ["agent-gateway-runtime", "release-gitops"]
---

# AI Gateway 服务 Context

仅在任务命中 `ai-gateway/`、模型 provider 或流式网关时加载。

- 协议、路由、流式和 fallback 行为由源码与测试拥有。
- Gateway Dashboard 与 DB migration 都有独立边界，不放回应用启动链。
- 运行服务测试并分别验证 source-facing、GitOps 和 Argo 证据。
