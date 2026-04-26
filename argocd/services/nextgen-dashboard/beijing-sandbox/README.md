# Nextgen Dashboard Beijing Sandbox

这个目录是 `nextgen-dashboard` 迁入北京 Argo CD 时的 deploy-facing 入口。

边界：

- source-facing 内容仍留在 `nextgen-dashboard/`
- Argo 只消费这个目录下收敛好的 deploy artifact
- 当前命名空间仍沿用现状：`user-auth`

## Planned Layout

- `kustomization.yaml`
  - deploy-facing 入口
- `ksops-secret-generator.yaml`
  - 让 Argo/ksops 在集群侧解出 `nextgen-dashboard-runtime-secrets`
- `nextgen-dashboard-platform.env`
  - image pin、node pool、redeploy timestamp
- `../../../secrets/beijing-sandbox/nextgen-dashboard-runtime-secrets.sops.yaml`
  - 由 `SSM -> CI -> sops` 导出

## Current Gap To Close

历史 service-local 脚本曾本地生成：

- `nextgen-dashboard/k8s/overlays/beijing-sandbox/generated/platform.env`
- `nextgen-dashboard/k8s/overlays/beijing-sandbox/generated/nextgen-dashboard-runtime-secrets.env`

要迁入 Argo，需要把它们替换成：

- Git 中可见的 deploy-facing image/node-pool artifact
- Git 中可见的 `*.sops.yaml` Secret artifact

当前已完成的部分：

- `nextgen-dashboard-platform.env` 已从现有北京 overlay 的本地生成值收敛到 deploy-facing 路径
- `kustomization.yaml` 已固化为 deploy-facing 入口
- `ksops-secret-generator.yaml` 已接好 secret 解密入口

当前仍未完成的部分：

- `nextgen-dashboard-runtime-secrets.sops.yaml` 还没有生成

## Required Secret Keys

`nextgen-dashboard-runtime-secrets` 最终需要提供这些键：

- `NEXTGEN_DASHBOARD_BASIC_AUTH_USER`
- `NEXTGEN_DASHBOARD_BASIC_AUTH_PASSWORD`
- `NEXTGEN_DASHBOARD_RUNNER_TOKEN`
- `NEXTGEN_DASHBOARD_PROXY_TOKEN_SECRET`
- `NEXTGEN_DASHBOARD_AUTH_MYSQL_DSN`
- `NEXTGEN_DASHBOARD_SANDBOX_MYSQL_DSN`

## Recommended Next Step

1. 先从 `SSM` 导出 `nextgen-dashboard-runtime-secrets.sops.yaml`
2. 最后再接入 root app
