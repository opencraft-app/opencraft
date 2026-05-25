# Payment Singapore Production

这个目录是 `payment` 接入新加坡 GitOps 时的 deploy-facing 入口。

边界：

- source-facing 内容仍留在 `payment/`
- 统一 Argo CD 控制面通过这个目录把资源下发到新加坡 `user-auth` namespace
- 第一阶段保留当前线上 Deployment / Service 语义，但显式不接 migration job，也不接 `wait-db-schema` initContainer

## Files

- `kustomization.yaml`
- `delete-migration-job.yaml`
- `delete-shared-bootstrap.yaml`
- `remove-initcontainer.yaml`
- `ksops-secret-generator.yaml`
- `payment-platform.env`
- `../../../secrets/sgprod/payment-runtime-secrets.sops.yaml`

## Current Runtime Contract

平台值：

- `PAYMENT_IMAGE`
- `PAYMENT_NODE_POOL`
- `PAYMENT_MYSQL_HOST`
- `PAYMENT_MYSQL_PORT`

Secret 键：

- `AI_GATEWAY_ADMIN_TOKEN`
- `LIGHTCLAW_INTERNAL_SERVICE_TOKEN`
- `PAYMENT_DB_PASSWORD`

## Note

`user-auth` namespace 和默认 `ServiceAccount` 已被更早接入的 app 共享持有，所以这只 app 不再试图接管这两个资源。
