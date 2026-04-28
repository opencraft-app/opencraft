# Subscription Argo CD Cutover

这份 runbook 只覆盖 `subscription` 北京测试环境接入统一 Argo CD 控制面 的步骤。

## Current State

当前北京现网已经有：

- namespace: `user-auth`
- deployment: `subscription`
- service: `subscription`
- configmap: `subscription-config`
- secret: `subscription-runtime-secrets`

## Source-facing Caveat

仓库里的 `subscription/k8s/base` 带 migration job。

北京首轮接入规则：

- Deployment / Service / ConfigMap / Secret 先纳管
- migration job 先不纳入 root app

## Target State

迁入 GitOps 后，目标路径是：

- app:
  - `argocd/apps/beijing-sandbox/subscription.yaml`
- service path:
  - `argocd/services/subscription/beijing-sandbox/`
- secret artifact:
  - `argocd/secrets/beijing-sandbox/subscription-runtime-secrets.sops.yaml`

## Inputs To Preserve

平台值：

- `SUBSCRIPTION_IMAGE`
- `SUBSCRIPTION_NODE_POOL`
- `SUBSCRIPTION_MYSQL_HOST`
- `SUBSCRIPTION_MYSQL_PORT`
- `SUBSCRIPTION_ALLOWED_ORIGINS`
- `SUBSCRIPTION_AI_GATEWAY_BASE_URL`
- `SUBSCRIPTION_FREE_PLAN_ID`
- `SUBSCRIPTION_LITE_PLAN_ID`
- `SUBSCRIPTION_PRO_PLAN_ID`
- `SUBSCRIPTION_DEPLOYED_AT`

Secret：

- `AI_GATEWAY_ADMIN_TOKEN`
- `LIGHTCLAW_INTERNAL_SERVICE_TOKEN`
- `MYSQL_ROOT_PASSWORD`
- `SUBSCRIPTION_ADMIN_TOKEN`
- `SUBSCRIPTION_DB_PASSWORD`
- `SUBSCRIPTION_MYSQL_DSN`
