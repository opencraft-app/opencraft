---
id: ticket-service-context
type: service
scope: 工单 realm 隔离、状态流转和审计日志的派生服务上下文。
triggers: ["ticket", "工单服务", "ticket audit"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - ticket/docs/README.md
  - ticket/catalog-info.yaml
status: active
reviewed_at: 2026-08-26
review_due: 2026-11-24
revision: 1.0.0
precedence: service
derived: true
related_packs: ["identity-access", "release-gitops"]
---

# Ticket 服务 Context

- 受理人只能操作本 realm 工单，门禁位于 admin middleware。
- 所有状态变化写入 `ticket_audit_log`，保持 `httpapi → service → store` 分层。
- 覆盖越权、非法状态转移、审计落库与 API 错误。
