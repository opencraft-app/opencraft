---
id: new-api-service-detail
type: service
scope: NewAPI 上游 subtree 与 mono2 集成的派生服务上下文。
triggers: ["new-api service", "new api gateway", "new-api 集成"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - new-api/docs/README.md
  - new-api/catalog-info.yaml
  - new-api/AGENTS.md
  - new-api/MONO2_SUBTREE.md
status: active
reviewed_at: 2026-09-01
review_due: 2026-11-30
revision: 2.1.0
precedence: service
derived: true
related_packs: ["agent-gateway-runtime", "upstream-subtrees"]
---

# NewAPI 服务 Context

仅在命中 `new-api/`、上游同步或本地集成时加载；先读 `new-api/AGENTS.md`。

## 当前边界

- `new-api` 来自上游的 squash subtree；mono2 只维护集成差异、发布接入和可回流补丁，不复制上游正文成为平行真源。
- 未明确选择上游版本时不得覆盖 `.mono2-subtree`。
- mono2 本地修复与上游同步 commit 必须可分离；镜像构建不等于 GitOps/Argo 发布。

## 按需深入与验证

同步规则读取 `new-api/MONO2_SUBTREE.md`，服务边界读取 `new-api/docs/README.md`。按实际修改分别运行 Go 或 `web/` 前端门禁，并核对 subtree pin、mono2 集成点和发布清单，不用无关的全仓测试替代。
