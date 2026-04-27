# Admin Gateway Beijing Sandbox

这个目录是 `admin-gateway` 接入北京 GitOps 时的 deploy-facing 入口。

边界：

- source-facing 内容仍留在 `admin-gateway/`
- 香港 Argo 通过这个目录把资源下发到北京 `lightclaw-gateway` namespace
- 当前模板按北京现网 Running 版本对齐，不主动引入新的 rollout 变化

## Files

- `kustomization.yaml`
- `ksops-secret-generator.yaml`
- `admin-gateway-platform.env`
- `config.yaml`
- `../../../secrets/beijing-sandbox-2/admin-gateway-runtime-secrets.sops.yaml`

## Current Runtime Contract

平台值：

- `ADMIN_GATEWAY_IMAGE`
- `ADMIN_GATEWAY_NODE_POOL`
- `ADMIN_GATEWAY_DEPLOYED_AT`
- `ADMIN_GATEWAY_PUBLIC_HOST`
- `ADMIN_GATEWAY_BRIDGE_COOKIE_HOSTS`
- `ADMIN_GATEWAY_TLS_SECRET_NAME`
- `ADMIN_GATEWAY_CLS_TOPIC_ID`

Secret 键：

- `SERVICE_GATEWAY_ADMIN_BASIC_AUTH_USER`
- `SERVICE_GATEWAY_ADMIN_BASIC_AUTH_PASSWORD`
- `SERVICE_GATEWAY_ADMIN_BRIDGE_COOKIE_SECRET` (optional; enables the stateless Basic Auth bridge cookie when present)

## Note

这只服务带公网 ingress 和 `TkeServiceConfig`。迁移阶段先保持北京现网 host、TLS secret 和 image 不变，只让 Argo 接管现状。

北京试点后，这个 deploy-facing 目录只保留环境值、配置输入和 secret 输入；
Ingress / `TkeServiceConfig` / `LogConfig` 等结构性逻辑统一留在 `admin-gateway/k8s/overlays/beijing-sandbox-2/`。
