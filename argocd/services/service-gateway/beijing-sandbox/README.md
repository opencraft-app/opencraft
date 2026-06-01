# Service Gateway Beijing Sandbox

这个目录是 `service-gateway` 接入北京 GitOps 时的 deploy-facing 入口。

边界：

- source-facing 内容仍留在 `service-gateway/`
- 统一 Argo CD 控制面通过这个目录把资源下发到北京 `lightclaw-gateway` namespace
- 当前模板按北京现网 Running 版本对齐，不主动改变公网 host、TLS 或路由

## Files

- `kustomization.yaml`
- `ksops-secret-generator.yaml`
- `service-gateway-platform.env`
- `config.yaml`
- `../../../secrets/beijing-sandbox/service-gateway-runtime-secrets.sops.yaml`

## Current Runtime Contract

平台值：

- `SERVICE_GATEWAY_IMAGE`
- `SERVICE_GATEWAY_NODE_POOL`
- `SERVICE_GATEWAY_DEPLOYED_AT`
- `SERVICE_GATEWAY_PUBLIC_HOST`
- `SERVICE_GATEWAY_TLS_SECRET_NAME`
- `SERVICE_GATEWAY_CLS_TOPIC_ID`
- `SERVICE_GATEWAY_REALNAME_WALL_ENABLED`

Secret 键：

- `SERVICE_GATEWAY_ADMIN_BASIC_AUTH_USER`
- `SERVICE_GATEWAY_ADMIN_BASIC_AUTH_PASSWORD`
- `SERVICE_GATEWAY_AUTH_INTERNAL_TOKEN`

## Note

这只服务是北京公网主入口。第一阶段只让 Argo 接管现网，不主动改变入口路径、LB、域名或 TLS 证书。

北京试点后，这个 deploy-facing 目录只保留环境值、配置输入和 secret 输入；
共享 namespace / serviceaccount 删除逻辑以及其它结构性 patch 已下沉到 `service-gateway/k8s/overlays/beijing-sandbox/`。
