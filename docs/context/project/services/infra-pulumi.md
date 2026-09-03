---
id: infra-pulumi-service-context
type: service
scope: Pulumi 基础设施控制面、环境 inventory 与 deploy 输出的派生服务上下文。
triggers: ["infra_pulumi", "infractl", "pulumi inventory"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - infra_pulumi/docs/README.md
  - infra_pulumi/catalog-info.yaml
status: active
reviewed_at: 2026-08-26
review_due: 2026-11-24
revision: 1.0.0
precedence: service
derived: true
related_packs: ["release-gitops", "site-environment-routing"]
---

# Infra Pulumi 服务 Context

- `infra_pulumi` 是当前唯一一方 infra 控制面，入口为 `cmd/infractl`。
- inventory 只保存非敏感事实；凭据走环境变量或 Pulumi Secret。
- `platform.env` 是可能含密的派生输入，不手改、不提交、不整份渲染到日志。
