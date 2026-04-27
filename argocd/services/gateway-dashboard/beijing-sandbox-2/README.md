# Gateway Dashboard Beijing Sandbox

这个目录是 `gateway-dashboard` 接入北京 GitOps 时的 deploy-facing 入口。

边界：

- source-facing 内容仍留在 `gateway-dashboard/`
- 香港 Argo 通过这个目录把资源下发到北京 `ai-gateway` namespace
- 当前模板按北京现网 Running 版本对齐，不主动引入新的 rollout 变化

## Files

- `kustomization.yaml`
- `ksops-secret-generator.yaml`
- `gateway-dashboard-platform.env`
- `../../../secrets/beijing-sandbox-2/gateway-dashboard-runtime-secrets.sops.yaml`

## Current Runtime Contract

ConfigMap 平台值：

- `GATEWAY_DASHBOARD_IMAGE`
- `GATEWAY_DASHBOARD_NODE_POOL`
- `GATEWAY_DASHBOARD_GATEWAY_API_URL`
- `GATEWAY_DASHBOARD_AUTH_ADMIN_API_URL`
- `GATEWAY_DASHBOARD_SUBSCRIPTION_ADMIN_API_URL`
- `GATEWAY_DASHBOARD_SANDBOX_API_URL`
- `GATEWAY_DASHBOARD_CTL_API_URL`
- `GATEWAY_DASHBOARD_CLS_TOPIC_ID`
- `GATEWAY_DASHBOARD_DEPLOYED_AT`

Secret 键：

- `ADMIN_TOKEN`
- `AUTH_ADMIN_TOKEN`
- `SUBSCRIPTION_ADMIN_TOKEN`

## Note

这只服务当前复用 `ai-gateway` namespace。迁移阶段先保留这个边界，避免把 namespace 切分和 GitOps 接入混成一次变更。
