# GitOps Platform Standard

这份文档把当前确认过的平台标准收成可执行边界。

## Topology

- 一个中心 GitLab
- 一个中心 Argo CD（当前在香港）
- 北京测试集群先作为远端 cluster 由中心 Argo 纳管
- 两个环境都使用同一个 canonical Git URL
- 中心 Argo 通过 internal ingress + internal DNS/TLS 私网访问 GitLab

## Repo Boundary

### Source-facing

服务目录只保留：

- 源码
- `k8s/base`
- `k8s/overlays/<env>`
- Docker build 输入
- migration / seed 输入（如适用）

禁止再把服务目录当作正式发布入口。

### Deploy-facing

`argocd/` 目录保留：

- `AppProject`
- root app
- 子 `Application`
- image pin
- `*.sops.yaml`
- env-level config / governance

关键规则：

- Argo 的唯一正式入口定义在 `argocd/`
- Argo 不允许直接盯任意服务源码树
- secret 导出产物只能进入 deploy-facing 路径
- `root/mono` 的长期定位遵守：
  - [gitops-root-mono-governance.md](gitops-root-mono-governance.md)
  - [gitops-release-contract.md](gitops-release-contract.md)

## Private Git Access

统一规则：

- repo URL 使用 canonical GitLab URL
- 不写集群内 service DNS 到 Argo `repoURL`
- 每个环境自己保证：
  - internal ingress
  - internal DNS/TLS
  - `repo-server` 走私网访问 canonical URL

验证标准：

```bash
git ls-remote https://code.lightclaw.tech/<group>/<repo>.git
```

需要能在 `repo-server` 内成功执行。

## Secret Standard

- 上游权威真源：Tencent Cloud `SSM`
- deployable snapshot：Git 中的 `*.sops.yaml`
- cluster-side decrypt：`Argo + ksops`
- runtime：只消费 K8s Secret

禁止事项：

- workload 运行时动态拉 `SSM`
- 本地 `.secret/*` 作为 Argo 必需输入
- 本地 `generated/*` 作为 Argo 必需输入

数据库 migration / seed 的长期治理单独遵守：

- [gitops-migration-governance.md](gitops-migration-governance.md)

## Standard Export Flow

1. 维护者更新 `SSM`
2. GitLab CI 读取 `SSM`
3. 渲染 K8s Secret YAML
4. 加密成 `*.sops.yaml`
5. bot 开 / 更新 PR
6. 合并后 Argo 同步

## Formal Release Rule

服务迁入正式主线后：

- Argo = 唯一正式发布入口
- service-local `deploy-k8s.sh` / `kubectl apply -k` 不再保留为正式路径

保留能力：

- 镜像构建
- 平台级 DB job 入口
- 平台级 break-glass

删除 service-local 正式发布能力前，必须满足：

- build path 独立可用
- Argo rollout 已验证
- rollback 已演练
- DB job path 已验证（如适用）
- docs 已切主线
- drift detection 可用

## Gateway Governance

公网入口治理单独遵守：

- [gitops-ingress-governance.md](gitops-ingress-governance.md)

共享 bootstrap ownership 和 `root/mono` 定位单独遵守：

- [gitops-root-mono-governance.md](gitops-root-mono-governance.md)
