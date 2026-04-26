# Deploy

`deploy/` 现在只承载**环境事实**，不再承载正式 workload 发布入口。

## 正式发布模型

- 正式北京 / 上海发布只认 `Argo CD`
- `deploy/envs/<env>/platform.env` 仍然由 `infra_pulumi` 产出
- 服务目录不再承担正式 `apply / release`
- 服务目录只保留：
  - 源码
  - `k8s/base`
  - `k8s/overlays/<env>`
  - 镜像构建输入
  - 必要 migration / seed 二进制与 SQL

## 当前边界

- `infra_pulumi/`
  - 负责云资源、TKE、TCR、数据库、Redis、监控与 kubeconfig
- `deploy/envs/<env>/`
  - 存放环境事实，如 `platform.env`
- `argocd/`
  - 正式发布入口
- `scripts/release-bundles.yaml`
  - 正式 release bundle import 清单

## 不再允许的主线

以下不再属于正式发布主线：

- service-local 正式发布命令
- 服务目录内 `kubectl apply -k`
- 任何 service-local `release` / `apply` 脚本

## 保留的能力

### 镜像构建

默认统一入口：

```bash
python3 scripts/build-release-image.py --service <service> --env <env> --tag <tag>
```

当前显式例外：

- `sandbox` 仍走 `python3 images/build-image.py`

### 数据库 migration / seed

统一入口：

- `scripts/run_gitops_db_job.py`
- 旧 `.gitlab/ci/gitops-db-job.yml` 已退役；当前以脚本和 runbook 为准

### 环境事实刷新

```bash
cd infra_pulumi
GOWORK=off go run ./cmd/infractl sync --stack <env>
```

## 当前目标

这轮重构的目标不是重做 secret 平台，也不是拆香港单控制面。  
目标只是把正式发布主线收敛成：

- `infra_pulumi` 产出环境事实
- `root/mono` 承载 deploy-facing 真源
- `Argo CD` 执行正式发布
