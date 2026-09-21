# NewAPI 上游服务

`new-api` 来自 `QuantumNous/new-api` 的 squash subtree。mono2 只维护集成差异、发布接入和可回流补丁，不把上游正文复制成一方事实。

## 权威入口

- [上游 README](../README.md)、[Agent 约束](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- [Subtree 契约](../MONO2_SUBTREE.md)
- [上游服务治理](../../docs/engineering/platform/README.md)

## 关键边界

未明确选择上游版本时不覆盖 `.mono2-subtree`。mono2 本地集成变更与上游同步 commit 必须可分离；镜像构建不等于 GitOps/Argo 发布。

## 验证

按实际修改分别运行 Go 与 `web/` 前端门禁，并检查 subtree pin、mono2 集成点和发布清单，不用无关全仓测试替代。
