# Nextgen Dashboard Argo CD Cutover

这份 runbook 只覆盖 `nextgen-dashboard` 北京测试环境的首批迁移。

## Current State

当前正式发布路径已经切到 `Argo`。  
历史上的 `deploy-k8s.sh` 只作为已废弃来源被记录，不再是正式入口。

## Target State

迁入 Argo 后，目标路径是：

- deploy-facing app:
  - `argocd/apps/beijing-sandbox/nextgen-dashboard.yaml`
- deploy-facing service path:
  - `argocd/services/nextgen-dashboard/beijing-sandbox/`
- secret artifact:
  - `argocd/secrets/beijing-sandbox/nextgen-dashboard-runtime-secrets.sops.yaml`

当前已落地：

- live 北京 root app：
  - `argocd/root/beijing-sandbox.yaml`
- live Application：
  - `argocd/apps/beijing-sandbox/nextgen-dashboard.yaml`
- deploy-facing platform pin：
  - `argocd/services/nextgen-dashboard/beijing-sandbox/nextgen-dashboard-platform.env`
- deploy-facing kustomization：
  - `argocd/services/nextgen-dashboard/beijing-sandbox/kustomization.yaml`
- deploy-facing ksops generator：
  - `argocd/services/nextgen-dashboard/beijing-sandbox/ksops-secret-generator.yaml`

当前仍待补：

- deploy-facing secret artifact：
  - `argocd/secrets/beijing-sandbox/nextgen-dashboard-runtime-secrets.sops.yaml`

## Inputs To Move

### From `generated/platform.env`

- `NEXTGEN_DASHBOARD_IMAGE`
- `NEXTGEN_DASHBOARD_NODE_POOL`
- `NEXTGEN_DASHBOARD_DEPLOYED_AT`

### From local runtime secret env

- `NEXTGEN_DASHBOARD_BASIC_AUTH_USER`
- `NEXTGEN_DASHBOARD_BASIC_AUTH_PASSWORD`
- `NEXTGEN_DASHBOARD_RUNNER_TOKEN`
- `NEXTGEN_DASHBOARD_PROXY_TOKEN_SECRET`
- `NEXTGEN_DASHBOARD_AUTH_MYSQL_DSN`
- `NEXTGEN_DASHBOARD_SANDBOX_MYSQL_DSN`

## Suggested Migration Sequence

1. 在腾讯云 `SSM` 创建 `mono-beijing-sandbox-nextgen-dashboard-runtime-secrets`
2. 用 [ssm_manifest.nextgen-dashboard.beijing-sandbox.yaml](../../scripts/ssm_manifest.nextgen-dashboard.beijing-sandbox.yaml) 生成 `*.sops.yaml`
3. 使用已提交的 `argocd/services/nextgen-dashboard/beijing-sandbox/nextgen-dashboard-platform.env` 作为 platform pin 基线
4. 使用仓库中的 `argocd/apps/beijing-sandbox/nextgen-dashboard.yaml` 作为 live app 定义
5. 通过 root app / Argo diff / sync 收敛，不再走 service-local apply

## Current Blocker

当前中心 GitLab canonical repo 已存在：

- `https://code.lightclaw.tech/root/mono.git`

当前运行形态已经收成：

- 香港 Argo = 中心控制面
- 北京集群 = 远端 destination cluster

在正式启用前，需要先明确：

- 香港 Argo repo-server 访问该 canonical URL 的内网入口和 DNS/TLS
- 香港 Argo repo-server 是否已经装好 `ksops` 和北京对应 age 私钥

## Open Decision

现在 `nextgen-dashboard` 继续复用 `user-auth` namespace。

在正式接入 root app 前，需要先明确：

- 是继续保留这个 namespace 边界
- 还是在迁移时一起拆成独立 namespace

这个决策会影响：

- Application destination
- secret namespace
- rollback 范围
