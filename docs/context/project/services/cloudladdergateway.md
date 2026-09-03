---
id: cloudladdergateway-service-context
type: service
scope: 强认证计费代理、Proto 契约、审计和 webhook 边界的派生服务上下文。
triggers: ["cloudladdergateway", "clgateway", "计费代理"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - cloudladdergateway/docs/README.md
  - cloudladdergateway/catalog-info.yaml
status: active
reviewed_at: 2026-08-26
review_due: 2026-11-24
revision: 1.0.0
precedence: service
derived: true
related_packs: ["subscription-entitlements", "release-gitops"]
---

# Cloud Ladder Gateway 服务 Context

- Proto 是协议真源，修改后运行 `make generate` 并提交对应 `gen/`。
- 公网请求不得绕过 HMAC/mTLS，Starlark 规则不得产生外部副作用。
- 进程内 webhook 没有持久化重试，不得当作可靠队列。
