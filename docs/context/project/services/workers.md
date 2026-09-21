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
reviewed_at: 2026-09-05
review_due: 2026-11-24
revision: 1.1.0
precedence: service
derived: true
related_packs: ["agent-gateway-runtime", "release-gitops"]
---

# Workers 服务 Context

- workflow 变更保护 determinism、补偿路径和 replay 兼容。
- 腾讯云永久凭据只走 Worker runtime Secret；救援 VM 仅接收对象级短期 STS，且不得把 STS 或含凭据的 TAT 脚本返回 Temporal History。
- Multipart 导出在 TAT 提交前持久化 Upload ID，失败与取消路径通过 disconnected cleanup context 执行 Abort 和残留对象删除。
- 运行 `go test ./...`、`go vet ./...`，容器变更在可用时构建镜像。
