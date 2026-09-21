---
id: user-auth-service-context
type: service
scope: 登录、会话、实名和身份 API 契约的派生服务上下文。
triggers: ["user/auth", "user-auth", "身份认证服务"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - user/auth/docs/README.md
  - user/auth/catalog-info.yaml
status: active
reviewed_at: 2026-08-26
review_due: 2026-11-24
revision: 1.0.0
precedence: service
derived: true
related_packs: ["identity-access", "release-gitops"]
---

# User Auth 服务 Context

- API 真源是 `user/auth/api/openapi.yaml`，网关/UI 不建立平行身份事实。
- migration/seed 不进启动路径，Secret 由 GitOps Secret 主线管理。
- 覆盖登录、会话过期、实名、回调伪造和公共网关路径。
