---
id: release-gitops
type: domain
scope: 镜像构建、晋级、GitOps、Argo CD 和线上发布验证。
triggers: ["release", "gitops", "argo", "promotion", "deployment"]
owner: mingyuxiao
authority: derived
source_of_truth:
  - docs/engineering/domains/release-gitops.md
  - argocd/README.md
  - .ci/AGENTS.md
  - .ci/runtime/commands/build_release_image.py
  - AGENTS.md
status: active
reviewed_at: 2026-08-25
review_due: 2026-11-23
revision: 2.0.0
precedence: domain
derived: true
---

# 发布与 GitOps

> 派生摘要：正式领域知识见 `docs/engineering/domains/release-gitops.md`；本页只保留影响 Agent 路由和实现决策的最小事实。

## 适用场景

任务构建镜像、变更部署 manifest、晋级环境或验证线上发布时使用。

## 影响决策的事实

- `master` 面向源码；`gitops` 面向部署，也是 Argo CD 跟踪的分支。
- 在存活 app 指向预期 revision 和镜像且 app 为 `Synced / Healthy` 前，源码变更不构成发布完成。
- 已合并 GitOps MR 本身不是部署结果。
- 生产晋级必须审慎；不得将自动沙箱行为当作生产路径。
- 前端发布验证要比对公共 `index.html` asset hash 与目标镜像内 hash。
- 长期陈旧的 Argo revision 可能需要 hard refresh，但只能在确认 app source、revision 和 workload image 后执行。

## 代码锚点

- `argocd/root/`
- `argocd/apps/`
- `argocd/services/`
- `.ci/runtime/commands/build_release_image.py`
- `.ci/runtime/build_and_promote_to_gitops.sh`

## 验证

使用服务特定构建命令，验证 GitOps revision 和镜像，再确认 Argo `Synced / Healthy`。前端还要比较公共和镜像内 asset hash。

## 不得推断

线上集群状态不能仅由 Git 证明。在 task pack 中记录实际 Argo 和 workload 证据。
