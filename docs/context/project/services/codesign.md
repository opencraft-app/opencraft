---
id: codesign-service-context
type: service
scope: 代码签名与外部交付平台操作知识的派生服务上下文。
triggers: ["codesign", "代码签名", "edgeone delivery"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - codesign/docs/README.md
  - codesign/catalog-info.yaml
status: active
reviewed_at: 2026-08-26
review_due: 2026-11-24
revision: 1.0.0
precedence: service
derived: true
related_packs: ["release-gitops"]
---

# Codesign 服务 Context

- 本目录是平台操作知识，不是线上 runtime。
- 记录可审计 ID、流程和结论，绝不记录密码、Token、cookie 或 kubeconfig。
- 外部平台当前状态需现场查询，明确已验证与未闭环项。
