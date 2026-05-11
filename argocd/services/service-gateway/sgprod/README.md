# Service Gateway Singapore Production

这个目录是 `service-gateway` 接入新加坡 GitOps 时的 deploy-facing 入口。

边界：

- source-facing 内容仍留在 `service-gateway/`
- 统一 Argo CD 控制面通过这个目录把资源下发到新加坡 `lightclaw-gateway` namespace
- 新加坡公网 API 入口使用 `api.lightvela.ai`

## Files

- `kustomization.yaml`
- `ksops-secret-generator.yaml`
- `service-gateway-platform.env`
- `config.yaml`
- `tls-secrets.yaml`
- `../../../secrets/sgprod/service-gateway-runtime-secrets.sops.yaml`

## Current Runtime Contract

平台值：

- `SERVICE_GATEWAY_IMAGE`
- `SERVICE_GATEWAY_NODE_POOL`
- `SERVICE_GATEWAY_DEPLOYED_AT`
- `SERVICE_GATEWAY_PUBLIC_HOST`
- `SERVICE_GATEWAY_TLS_SECRET_NAME`
- `SERVICE_GATEWAY_CLS_TOPIC_ID`
- `SERVICE_GATEWAY_REALNAME_WALL_ENABLED`（可选，缺省为 `true`）

Secret 键：

- `AI_GATEWAY_ADMIN_TOKEN`
- `SERVICE_GATEWAY_ADMIN_BASIC_AUTH_USER`
- `SERVICE_GATEWAY_ADMIN_BASIC_AUTH_PASSWORD`
- `SERVICE_GATEWAY_AUTH_INTERNAL_TOKEN`

## Note

这只服务是新加坡公网主入口。当前 GitOps 视图已切到 `api.lightvela.ai`，TLS secret 名为 `api-lightvela-ai-tls`。

另外，`lightclaw-gateway` namespace 和默认 `ServiceAccount` 当前会被多个 app 共享。
所以这只 app 会显式删掉：

- `Namespace/lightclaw-gateway`
- `ServiceAccount/lightclaw-gateway/default`
- `tls-secrets.yaml` 内的 `XV7Zeg81` 必须在正式同步前替换为腾讯云证书 ID
