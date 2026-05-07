# GitOps Repo Governance

这份文档定义当前 GitOps 真源和共享 bootstrap ownership 的长期边界。

## Repository Boundary

- `git@git.woa.com:wisp/mono2.git` 是当前源码仓。
- `gitops` 是当前统一 Argo CD 控制面消费的发布分支。
- `master` 只负责日常开发和构建触发。
- 长期配置变更必须最终收敛到当前 repo 的 `gitops` 分支。
- 不允许保留历史 deploy-only 仓差异作为正式真相源。

## Current GitOps Repo Positioning

当前 repo 的 `gitops` 分支不是日常开发分支，而是：

- GitOps 发布视图
- 当前统一 Argo CD 控制面消费的发布分支
- 只承载：
  - deploy-facing `argocd/`
  - 明确声明的 release bundle imports

也就是说，当前长期默认是：

- **不是另一个 deploy-only 镜像仓**
- **不是任意 source-facing 子集分支**
- **是当前源码仓中的 deploy-facing 发布分支**

## Inclusion Rule

只有满足下面任一条件的文件，才应该进入当前 repo 的 `gitops` 发布视图：

1. `argocd/` 下的 deploy-facing 文件
2. 在 [.ci/runtime/bundles/*.bundle](../../.ci/runtime/bundles/) 中明确声明的 release bundle import
3. GitOps 路径必需的脚本 / manifest 模板
4. 与已纳管服务直接相关的 runbook / governance 文档

每个 release bundle import 至少要有：

- `source`
- `owner`
- `reason`
- `allowed_paths`
- `exit_condition`

不应默认进入 `root/mono` 的：

- 与当前已纳管服务无关的源码
- 用户本地调试资产
- 与 GitOps 主链无关的工作树脏改动

## Shared Bootstrap Ownership

### `user-auth`

当前共享 bootstrap 规则：

- `Namespace/user-auth`
- `ServiceAccount/user-auth/default`

由**更早接入、且首先需要这些资源的 app 维持存在**。  
后续接入的新 app 不再重复持有它们。

具体执行上：

- `nextgen-dashboard`
- `subscription`
- `lightclaw-auth`
- `payment`
- `session`

这些都不应该再重复试图拥有 `user-auth` namespace bootstrap。

### `lightclaw-gateway`

长期规则：

- `Namespace/lightclaw-gateway`
- `ServiceAccount/lightclaw-gateway/default`

统一由 **`admin-gateway`** 持有。

`service-gateway` 不再持有这两个共享 bootstrap 资源。

### `ai-gateway`

长期规则：

- `Namespace/ai-gateway`
- `ServiceAccount/ai-gateway/default`

作为共享 bootstrap 基础设施存在，后续 app 不应再重复声明 owner。

## Ownership Rule

共享 bootstrap 资源遵守：

1. 一个 namespace 只有一个长期 owner
2. 后接入 app 只能消费，不能再争抢 ownership
3. 如果 source-facing base 不包含这些资源，就不要为了“形式统一”再造 delete patch
4. 共享 bootstrap 的 owner 变更属于平台级治理动作，不属于单服务普通发布动作

## GitOps Branch Update Rule

每新增一个被纳管服务，进入 `gitops` 发布视图的最小集合必须同时包含：

- 该服务的 `argocd/apps/<env>/<service>.yaml`
- 该服务的 `argocd/services/<service>/<env>/...`
- 该服务对应的 release bundle import
- 该服务对应的 `sops` secret artifact

如果只提交 deploy-facing 文件，而漏掉对应的 release bundle import 声明，视为不合格提交。

## When To Revisit This Rule

只有在下面两种情况下，才应该重新讨论 `root/mono` 定位：

1. 你决定把中心 GitOps 仓库升级成完整 mono 镜像
2. 你决定拆成多仓、多 root app、多 canonical repo

在那之前，默认坚持：

- `root/mono = deploy-facing + explicitly declared release bundle imports only`
