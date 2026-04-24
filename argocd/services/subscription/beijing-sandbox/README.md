# Subscription Beijing Sandbox

这个目录是 `subscription` 接入北京 GitOps 时的 deploy-facing 入口。

边界：

- source-facing 内容仍留在 `subscription/`
- 香港 Argo 通过这个目录把资源下发到北京 `user-auth` namespace
- 第一阶段保留当前线上 Deployment 语义，但显式不接 migration job

## Files

- `kustomization.yaml`
- `delete-migration-job.yaml`
- `ksops-secret-generator.yaml`
- `subscription-platform.env`
- `../../../secrets/beijing-sandbox/subscription-runtime-secrets.sops.yaml`

## Current Runtime Contract

平台值：

- `SUBSCRIPTION_IMAGE`
- `SUBSCRIPTION_NODE_POOL`
- `SUBSCRIPTION_MYSQL_HOST`
- `SUBSCRIPTION_MYSQL_PORT`
- `SUBSCRIPTION_ALLOWED_ORIGINS`
- `SUBSCRIPTION_AI_GATEWAY_BASE_URL`
- `SUBSCRIPTION_FREE_PLAN_ID`
- `SUBSCRIPTION_LITE_PLAN_ID`
- `SUBSCRIPTION_PRO_PLAN_ID`
- `SUBSCRIPTION_DEPLOYED_AT`

Secret 键：

- `AI_GATEWAY_ADMIN_TOKEN`
- `LIGHTCLAW_INTERNAL_SERVICE_TOKEN`
- `MYSQL_ROOT_PASSWORD`
- `SUBSCRIPTION_ADMIN_TOKEN`
- `SUBSCRIPTION_DB_PASSWORD`
- `SUBSCRIPTION_MYSQL_DSN`

## Note

`subscription/k8s/base` 当前包含 migration job。北京首轮接入时先不把 job 纳进来，避免第一次 GitOps 接管就触发新的 DB 迁移任务。

另外，`user-auth` namespace 和默认 `ServiceAccount` 目前由更早接入的组件持有。
所以这只 app 会显式删掉：

- `Namespace/user-auth`
- `ServiceAccount/user-auth/default`
