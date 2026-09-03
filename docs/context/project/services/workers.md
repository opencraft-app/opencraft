---
id: workers-service-context
type: service
scope: Temporal workflow、rescue exporter 与 uploader 的派生服务上下文。
triggers: ["workers", "temporal worker", "rescue exporter"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - workers/docs/README.md
  - workers/catalog-info.yaml
status: active
reviewed_at: 2026-08-26
review_due: 2026-11-24
revision: 1.0.0
precedence: service
derived: true
related_packs: ["agent-gateway-runtime", "release-gitops"]
---

# Workers 服务 Context

- workflow 变更保护 determinism、补偿路径和 replay 兼容。
- Temporal/COS/腾讯云凭据只走运行时 Secret，不作为命令行参数。
- 运行 `go test ./...`、`go vet ./...`，容器变更在可用时构建镜像。
