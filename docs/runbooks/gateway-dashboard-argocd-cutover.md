# Gateway Dashboard Argo CD Cutover

这份 runbook 只覆盖 `gateway-dashboard` 北京测试环境接入统一 Argo CD 控制面 的步骤。

## Current State

当前北京现网已经有：

- namespace: `ai-gateway`
- deployment: `gateway-dashboard`
- configmap: `gateway-dashboard-config`
- configmap: `gateway-dashboard-platform-values`
- secret: `gateway-dashboard-runtime-secrets`

## Target State

迁入 GitOps 后，目标路径是：

- app:
  - `argocd/apps/beijing-sandbox/gateway-dashboard.yaml`
- service path:
  - `argocd/services/gateway-dashboard/beijing-sandbox/`
- secret artifact:
  - `argocd/secrets/beijing-sandbox/gateway-dashboard-runtime-secrets.sops.yaml`

## Inputs To Preserve

平台值：

- `GATEWAY_DASHBOARD_IMAGE`
- `GATEWAY_DASHBOARD_NODE_POOL`
- `GATEWAY_DASHBOARD_GATEWAY_API_URL`
- `GATEWAY_DASHBOARD_AUTH_ADMIN_API_URL`
- `GATEWAY_DASHBOARD_SUBSCRIPTION_ADMIN_API_URL`
- `GATEWAY_DASHBOARD_SANDBOX_API_URL`
- `GATEWAY_DASHBOARD_CTL_API_URL`
- `GATEWAY_DASHBOARD_CLS_TOPIC_ID`
- `GATEWAY_DASHBOARD_DEPLOYED_AT`

Secret：

- `ADMIN_TOKEN`
- `AUTH_ADMIN_TOKEN`
- `SUBSCRIPTION_ADMIN_TOKEN`

## Migration Rule

这只服务应先对齐北京当前线上可运行模板：

- 不主动改变 image tag
- 不主动改变 namespace
- 不主动改变 secret 名

先纳管成功，再做后续收敛。 
