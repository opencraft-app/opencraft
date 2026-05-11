# Admin Gateway Singapore Production

这个目录是 `admin-gateway` 接入新加坡 GitOps 时的 deploy-facing 入口。

边界：

- source-facing 内容仍留在 `admin-gateway/`
- 统一 Argo CD 控制面通过这个目录把资源下发到新加坡 `lightclaw-gateway` namespace
- 新加坡公网管理入口使用 `admin.lightvela.ai`

## Files

- `kustomization.yaml`
- `ksops-secret-generator.yaml`
- `admin-gateway-platform.env`
- `config.yaml`
- `tls-secrets.yaml`
- `../../../secrets/sgprod/admin-gateway-runtime-secrets.sops.yaml`

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

这只服务带公网 ingress 和 `TkeServiceConfig`。当前 GitOps 视图已切到 `admin.lightvela.ai`，TLS secret 名为 `admin-lightvela-ai-tls`。

当前约定：

- `lightclaw-gateway` 的 namespace bootstrap 由 `admin-gateway` 侧继续持有
- `service-gateway` 不再接管这两个共享资源
- `tls-secrets.yaml` 内的 `XV7Zeg81` 必须在正式同步前替换为腾讯云证书 ID
