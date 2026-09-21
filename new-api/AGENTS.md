# new-api

在 mono2 内维护的 NewAPI 上游 subtree。

## 边界

- 这是来自 `QuantumNous/new-api` 的 squash 风格 subtree。
- 详细指引延后至 [new-api 服务详情](../docs/context/project/services/new-api.md)。
- 上游选择与同步规则由 `new-api/MONO2_SUBTREE.md` 管理。

## 命令

使用变更文件要求的服务本地前端/后端命令。源码变更不等于上游同步。

## 硬规则

- 未明确选定上游版本时，不得覆盖 `.mono2-subtree`。
- 不得把镜像构建视为 GitOps 发布完成。
- mono2 本地修复与上游同步 commit 必须可分离。
