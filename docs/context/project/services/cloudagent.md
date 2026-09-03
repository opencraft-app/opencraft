---
id: cloudagent-service-context
type: service
scope: CloudAgent gateway、渠道、Wisp 与运行时制品的派生服务上下文。
triggers: ["cloudagent", "channelgateway", "wisp runtime"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - cloudagent/docs/README.md
  - cloudagent/catalog-info.yaml
status: active
reviewed_at: 2026-08-26
review_due: 2026-11-24
revision: 1.0.0
precedence: service
derived: true
related_packs: ["agent-gateway-runtime", "release-gitops"]
---

# CloudAgent 服务 Context

仅在任务命中 `cloudagent/`、ChannelGateway、Wisp 或 runtime artifact 时加载。

- gateway、ChannelGateway 与 Wisp/runtime artifact 是不同 CI/发布面。
- 跨面变更分别验证 artifact URL/SHA、gateway image、Argo 和 `/v1/selfcheck`。
- 使用最近子模块的 Go/Rust/Node 门禁，不用一个全仓命令掩盖边界。
