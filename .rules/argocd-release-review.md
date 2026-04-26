# Argo CD 发布评审规则

适用范围：

- `argocd/**`
- `*/k8s/**`
- `scripts/*gitops*`
- `scripts/build-release-image.py`
- `scripts/release-bundles.yaml`

目标：

- 约束 AI / 自动化在 GitOps 发布链路上的改动边界
- 降低错误发布、错误集群入口修改、错误证书变更的风险

## P0 禁止项

### 1. 严禁修改或纳管 Ingress SSL 证书

以下内容默认视为高风险变更，AI 评审必须直接拦截：

- 修改任何 `Ingress.spec.tls[].secretName`
- 修改任何 `TkeServiceConfig` / CLB / 监听器里关联的证书或 TLS secret 名称
- 新增、替换、删除任何用于公网入口的 TLS Secret
- 把证书轮换、证书接入、证书命名重构，混入普通业务发布 MR

规则：

- 证书不是普通发布内容
- 证书变更必须由明确的人为专项操作处理
- 普通服务发布、镜像升级、配置调整，不得顺手改证书引用

评审提示：

- 如果 diff 中出现 `secretName:` 且上下文是 Ingress/TLS，默认按阻断处理
- 如果 diff 中出现 `TLS` / `certificate` / `cert` / `ssl` / `https listener` 相关入口配置，默认要求人工复核

### 2. 严禁在普通发布中切换 GitOps 真源

以下内容默认不允许作为普通发布的一部分：

- 修改 `Application.spec.source.repoURL`
- 修改 `Application.spec.source.targetRevision`
- 修改 `Application.spec.destination.name`
- 修改正式环境 `project` 归属，除非是明确的迁移任务

规则：

- 普通发布只能更新镜像 pin 或必要的 deploy-facing 配置
- 不得借发布顺手切 GitOps 仓库、分支、目标集群

### 3. 严禁在普通发布中修改集群或仓库凭据

以下内容默认不允许：

- 修改 repo 凭据
- 修改 cluster secret
- 修改 `sops-age` / SSH 私钥 / API token 等运行时凭据
- 修改 Argo CD repo-server runtime 凭据挂载方式

这类变更必须单独审查。

## 高风险变更提醒

以下变更不是一律禁止，但必须提升审查等级：

- 修改任何 `Ingress` host
- 修改任何 `TkeServiceConfig` listener / rule
- 修改 `LogConfig` topic / cls 路径
- 修改 `Service` 暴露端口
- 修改 `Deployment` 的 image 以外字段
- 修改 `k8s/base/**` 而不是仅改 `argocd/services/<service>/<env>/*-platform.env`

## 推荐发布边界

### 1. 普通发布优先只改这些

- `argocd/services/<service>/<env>/*-platform.env`
- 少量与该服务直接相关的 deploy-facing config

### 2. 共享镜像发布必须成组评审

如果多个 deployable unit 共享同一镜像，例如：

- `service-gateway`
- `admin-gateway`

那么评审必须确认：

- 这次改动是否会同时影响多个服务
- CI 触发范围是否覆盖共享镜像相关目录
- GitOps pin 是否会一起更新所有共享消费者

### 3. Promote 分支不应该承载额外语义

`promote-*` 分支只用于：

- 承载 image pin 变更
- 触发 GitOps MR

不应在其中混入：

- 额外业务逻辑改动
- 证书改动
- 集群入口重构
- 凭据修改

## 评审检查清单

AI 评审发布相关 MR 时，至少检查：

1. 这次改动是不是只在预期环境生效
2. 是否修改了 `repoURL` / `targetRevision` / `destination`
3. 是否触碰了 Ingress TLS / 证书 / listener
4. 是否触碰了 repo/cluster/runtime 凭据
5. 是否存在共享镜像但只更新了部分消费者
6. 是否把 `master` 侧源码变更和 `gitops` 发布变更混到同一个 MR

## 一句话原则

- 普通 Argo CD 发布，默认只允许改“要发哪个镜像、发到哪个环境”的内容
- 证书、入口、凭据、GitOps 真源切换，默认都不是普通发布的一部分
