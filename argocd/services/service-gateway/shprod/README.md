# Service Gateway Shanghai Production

这个目录是 `service-gateway` 接入上海 GitOps 时的 deploy-facing 入口。

边界：

- source-facing 内容仍留在 `service-gateway/`
- 统一 Argo CD 控制面通过这个目录把资源下发到上海 `lightclaw-gateway` namespace
- 当前模板按上海现网 Running 版本对齐，不主动改变公网 host、TLS 或路由

## Files

- `kustomization.yaml`
- `ksops-secret-generator.yaml`
- `service-gateway-platform.env`
- `config.yaml`
- `../../../secrets/shprod/service-gateway-runtime-secrets.sops.yaml`

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

- `SERVICE_GATEWAY_ADMIN_BASIC_AUTH_USER`
- `SERVICE_GATEWAY_ADMIN_BASIC_AUTH_PASSWORD`
- `SERVICE_GATEWAY_AUTH_INTERNAL_TOKEN`

## Note

这只服务是上海公网主入口。第一阶段只让 Argo 接管现网，不主动改变入口路径、LB、域名或 TLS 证书。

另外，`lightclaw-gateway` namespace 和默认 `ServiceAccount` 当前会被多个 app 共享。
所以这只 app 会显式删掉：

- `Namespace/lightclaw-gateway`
- `ServiceAccount/lightclaw-gateway/default`
