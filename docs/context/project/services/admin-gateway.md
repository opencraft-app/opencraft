---
id: admin-gateway-service-context
type: service
scope: 管理面网关入口、鉴权代理与独立发布边界的派生服务上下文。
triggers: ["admin-gateway", "管理面网关", "gateway dashboard proxy"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - admin-gateway/docs/README.md
  - admin-gateway/catalog-info.yaml
status: active
reviewed_at: 2026-08-26
review_due: 2026-11-24
revision: 1.0.0
precedence: service
derived: true
related_packs: ["identity-access", "release-gitops"]
---

# Admin Gateway 服务 Context

仅在任务命中 `admin-gateway/` 或管理面代理时加载。正式知识见 `admin-gateway/docs/README.md`；最近 `AGENTS.md` 仍提供目录硬约束。

- 该网关代理管理面，不与 `service-gateway` 共用发布责任。
- 当前复用 Dockerfile/build context 只是构建实现，不代表镜像或 Argo 应用合并。
- 验证管理入口、鉴权失败、Dashboard upstream 和独立 Argo 状态。
