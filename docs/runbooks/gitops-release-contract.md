# GitOps Release Contract

这份文档定义正式发布进入 `Argo` 前必须满足的最小契约。

## Formal Release Rule

- 正式发布只认 `Argo CD`
- 服务目录不再承担正式 `apply / release` 动作
- 服务目录只保留：
  - 源码
  - `k8s/base`
  - `k8s/overlays/<env>`
  - 镜像构建输入
  - 必要 migration/seed 二进制与 SQL

## Artifact Ownership Contract

每个正式发布 bundle 必须在 [scripts/release-bundles.yaml](../../scripts/release-bundles.yaml) 中声明：

- `source`
- `owner`
- `reason`
- `allowed_paths`
- `exit_condition`

如果 bundle 具备镜像构建能力，还必须声明：

- `dockerfile`
- `build_context`
- `image_repo`

服务 repo 是 deployable semantics 的 owner。  
`root/mono` 不是服务源码仓，只消费 release bundle import。

## Image Build Contract

对具备 `dockerfile/build_context/image_repo` 的 bundle，统一入口：

```bash
python3 scripts/build-release-image.py --service <service> --env <env> --tag <tag>
```

需要推镜像时：

```bash
python3 scripts/build-release-image.py --service <service> --env <env> --tag <tag> --push
```

输出：

- 标准镜像名 `<repo>:<tag>`

例外：

- `sandbox` 当前仍走 `images/build-image.py`
- 在它被正式 bundle 化之前，不强行纳入 `scripts/build-release-image.py`

## Image Pin Contract

- deploy-facing image pin 只允许写在：
  - `argocd/services/<service>/<env>/*-platform.env`
- 正式变更通过 `root/mono` 合并进入 Argo
- 禁止在集群里手工 patch image 当作正式路径

## Promotion Contract

- `beijing-sandbox -> shprod` 只允许 promotion PR / pin bump
- `shprod` 不允许手工 patch
- promotion 必须绑定明确 revision / image tag

## Promotion Negative Contract

至少要能证明这两件事：

1. `shprod` 不存在 service-local 正式发布路径
2. `shprod` 的 live 变更如果不经过 Git/Argo，会被 drift detection 发现

## Rollback Contract

正式回滚只允许：

- `git revert`
- 或等价的 promotion reverse

回滚完成定义：

- Argo 收敛回 `Synced / Healthy`
- workload 恢复健康

## DB Job Contract

`DB migration / seed` 继续保留，但只保留统一平台级入口：

- [run_gitops_db_job.py](../../scripts/run_gitops_db_job.py)
- [.gitlab/ci/gitops-db-job.yml](../../.gitlab/ci/gitops-db-job.yml)
- [gitops-db-job-runbook.md](gitops-db-job-runbook.md)

禁止：

- 在服务目录发布脚本里夹带 migration / seed 主线
- 在 Deployment 启动路径里隐式做 schema 变更

## Break-glass Contract

允许平台级 break-glass，但必须满足：

- 不复活 service-local 正式发布脚本
- 有 runbook
- 有责任人
- 有审计记录

## Formal Release Completion

一个服务删除 service-local 正式发布路径前，必须提供这些证据：

1. build path 独立可用
2. Argo rollout 可用
3. rollback drill 通过
4. DB job path 可用（如适用）
5. docs 已切主线
6. drift detection 可用
