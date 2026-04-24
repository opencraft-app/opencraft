# Service Gateway Argo CD Cutover

这份 runbook 只覆盖 `service-gateway` 北京测试环境接入香港中心 Argo 的步骤。

## Current State

当前北京现网已经有：

- namespace: `lightclaw-gateway`
- deployment: `service-gateway`
- services:
  - `service-gateway`
  - `service-gateway-ingress`
- ingress:
  - `lightclaw-public`
- `TkeServiceConfig`:
  - `lightclaw-public-config`
- configmaps:
  - `service-gateway-config`
  - `service-gateway-platform-values`
- secret:
  - `service-gateway-runtime-secrets`

## Target State

迁入 GitOps 后，目标路径是：

- app:
  - `argocd/apps/beijing-sandbox/service-gateway.yaml`
- service path:
  - `argocd/services/service-gateway/beijing-sandbox/`
- secret artifact:
  - `argocd/secrets/beijing-sandbox/service-gateway-runtime-secrets.sops.yaml`

## Inputs To Preserve

平台值：

- `SERVICE_GATEWAY_IMAGE`
- `SERVICE_GATEWAY_NODE_POOL`
- `SERVICE_GATEWAY_DEPLOYED_AT`
- `SERVICE_GATEWAY_PUBLIC_HOST`
- `SERVICE_GATEWAY_TLS_SECRET_NAME`
- `SERVICE_GATEWAY_CLS_TOPIC_ID`

Secret：

- `AI_GATEWAY_ADMIN_TOKEN`
- `SERVICE_GATEWAY_ADMIN_BASIC_AUTH_USER`
- `SERVICE_GATEWAY_ADMIN_BASIC_AUTH_PASSWORD`
- `SERVICE_GATEWAY_AUTH_INTERNAL_TOKEN`

Config file：

- `auth_service_url`
- `allowed_origins`
- `routes`

## Migration Rule

这只服务是北京公网主入口。

首轮接入规则：

- 不主动改域名
- 不主动改 TLS secret
- 不主动改 `TkeServiceConfig`
- 不主动改路由配置

先纳管现网，再谈收敛和清理。
