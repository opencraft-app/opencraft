# AI Gateway Beijing Sandbox

这个目录是 `ai-gateway` 接入北京 GitOps 时的 deploy-facing 入口。

边界：

- source-facing 内容仍留在 `ai-gateway/`
- 统一 Argo CD 控制面通过这个目录把资源下发到北京 `ai-gateway` namespace
- 第一阶段保留当前线上 Deployment / Service / internal ingress 语义，但显式不接 migration job

## Files

- `kustomization.yaml`
- `delete-migration-job.yaml`
- `delete-shared-bootstrap.yaml`
- `ksops-secret-generator.yaml`
- `ai-gateway-platform.env`
- `config.yaml`
- `../../../secrets/beijing-sandbox/ai-gateway-runtime-secrets.sops.yaml`

## Current Runtime Contract

平台值：

- `AI_GATEWAY_IMAGE`
- `AI_GATEWAY_NODE_POOL`
- `AI_GATEWAY_INTERNAL_SUBNET_ID`
- `AI_GATEWAY_MYSQL_HOST`
- `AI_GATEWAY_MYSQL_PORT`
- `AI_GATEWAY_REDIS_ADDR`
- `AI_GATEWAY_DEPLOYED_AT`

Secret 键：

- `ADMIN_TOKEN`
- `AI_GATEWAY_DB_PASSWORD`
- `AI_GATEWAY_MIGRATE_DSN`
- `DATABASE_URL`
- `ENCRYPTION_KEY`
- `LIGHTCLAW_INTERNAL_SERVICE_TOKEN`
- `MYSQL_ROOT_PASSWORD`
- `REDIS_PASSWORD`
- `REGISTRY_TOKEN`

## Note

这只服务和 `gateway-dashboard` 共用 `ai-gateway` namespace，所以不会再持有：

- `Namespace/ai-gateway`
- `ServiceAccount/ai-gateway/default`
