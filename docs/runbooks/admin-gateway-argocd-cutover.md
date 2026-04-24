# Admin Gateway Argo CD Cutover

这份 runbook 只覆盖 `admin-gateway` 北京测试环境接入香港中心 Argo 的步骤。

## Current State

当前北京现网已经有：

- namespace: `lightclaw-gateway`
- deployment: `admin-gateway`
- ingress: `admin-lightclaw-public`
- `TkeServiceConfig`: `admin-lightclaw-public-config`
- configmap: `admin-gateway-config`
- configmap: `admin-gateway-platform-values`
- secret: `admin-gateway-runtime-secrets`

## Target State

迁入 GitOps 后，目标路径是：

- app:
  - `argocd/apps/beijing-sandbox/admin-gateway.yaml`
- service path:
  - `argocd/services/admin-gateway/beijing-sandbox/`
- secret artifact:
  - `argocd/secrets/beijing-sandbox/admin-gateway-runtime-secrets.sops.yaml`

## Inputs To Preserve

平台值：

- `ADMIN_GATEWAY_IMAGE`
- `ADMIN_GATEWAY_NODE_POOL`
- `ADMIN_GATEWAY_DEPLOYED_AT`
- `ADMIN_GATEWAY_PUBLIC_HOST`
- `ADMIN_GATEWAY_TLS_SECRET_NAME`
- `ADMIN_GATEWAY_CLS_TOPIC_ID`

Secret：

- `SERVICE_GATEWAY_ADMIN_BASIC_AUTH_USER`
- `SERVICE_GATEWAY_ADMIN_BASIC_AUTH_PASSWORD`

Config file：

- `auth_service_url`
- `allowed_origins`
- `routes`

## Migration Rule

这只服务应先对齐北京当前线上可运行模板：

- 不主动改变 image tag
- 不主动改变公网 host
- 不主动改变 TLS secret name
- 不主动改变 config.yaml 内容

先纳管成功，再做后续收敛。
