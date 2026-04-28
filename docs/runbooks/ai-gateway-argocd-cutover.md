# AI Gateway Argo CD Cutover

这份 runbook 只覆盖 `ai-gateway` 北京测试环境接入统一 Argo CD 控制面 的步骤。

## Current State

当前北京现网已经有：

- namespace: `ai-gateway`
- deployment: `gateway-backend`
- services:
  - `gateway`
  - `gateway-backend`
  - `gateway-model-ingress`
- ingress:
  - `gateway-model-internal`
- configmaps:
  - `ai-gateway-platform-values`
  - `ai-gateway-runtime-config`
  - `gateway-backend-config`
- secret:
  - `ai-gateway-runtime-secrets`

## Source-facing Caveat

仓库里的 `ai-gateway/k8s/base` 带 migration job。

北京首轮接入规则：

- Deployment / Service / Ingress / ConfigMap / Secret 先纳管
- migration job 先不纳入 root app

## Inputs To Preserve

平台值：

- `AI_GATEWAY_IMAGE`
- `AI_GATEWAY_NODE_POOL`
- `AI_GATEWAY_INTERNAL_SUBNET_ID`
- `AI_GATEWAY_MODEL_INTERNAL_LB_ID`
- `AI_GATEWAY_MYSQL_HOST`
- `AI_GATEWAY_MYSQL_PORT`
- `AI_GATEWAY_REDIS_ADDR`
- `AI_GATEWAY_DEPLOYED_AT`

Secret：

- `ADMIN_TOKEN`
- `AI_GATEWAY_DB_PASSWORD`
- `AI_GATEWAY_MIGRATE_DSN`
- `DATABASE_URL`
- `ENCRYPTION_KEY`
- `LIGHTCLAW_INTERNAL_SERVICE_TOKEN`
- `MYSQL_ROOT_PASSWORD`
- `REDIS_PASSWORD`
- `REGISTRY_TOKEN`
