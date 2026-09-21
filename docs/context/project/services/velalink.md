---
id: velalink-service-context
type: service
scope: VelaLink 桌面、Chat UI、daemon、观测和上游同步的派生服务上下文。
triggers: ["velalink", "vela desktop", "vela chat ui"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - velalink/docs/README.md
  - velalink/catalog-info.yaml
status: active
reviewed_at: 2026-08-26
review_due: 2026-11-24
revision: 1.0.0
precedence: service
derived: true
related_packs: ["agent-gateway-runtime", "site-environment-routing"]
---

# VelaLink 服务 Context

- 桌面、Chat UI、daemon 和 vendored Codex 使用各自最窄子组件 Context。
- 默认反馈闭环是 `make desktop-preview`，预览与打包 Vela 数据隔离。
- 保留 subtree pin；影响 `frontend` consumer 时同步验证消费端。
