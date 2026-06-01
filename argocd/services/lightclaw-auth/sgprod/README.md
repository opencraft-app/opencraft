# Lightclaw Auth Singapore Production

这个目录是 `lightclaw-auth` 接入新加坡 GitOps 时的 deploy-facing 入口。

边界：

- source-facing 内容仍留在 `user/auth/`
- 统一 Argo CD 控制面通过这个目录把资源下发到新加坡 `user-auth` namespace
- 第一阶段保留当前线上 Deployment / Service / internal LB 语义，但显式不接 migration / seed job

## Files

- `kustomization.yaml`
- `delete-jobs.yaml`
- `delete-shared-bootstrap.yaml`
- `ksops-secret-generator.yaml`
- `auth-platform.env`
- `../../../secrets/sgprod/lightclaw-auth-secrets.sops.yaml`

## Current Runtime Contract

平台值：

- `AUTH_IMAGE`
- `AUTH_NODE_POOL`
- `AUTH_INTERNAL_SUBNET_ID`
- `AUTH_MYSQL_HOST`
- `AUTH_MYSQL_PORT`
- `AUTH_PUBLIC_BASE_URL`
- `AUTH_FRONTEND_BASE_URL`
- `AUTH_QQ_APP_ID`
- `AUTH_QQ_REDIRECT_URI`
- `AUTH_WECHAT_APP_ID`
- `AUTH_WECHAT_REDIRECT_URI`
- `AUTH_WECHAT_OFFICIAL_ACCOUNT_APP_ID`
- `AUTH_WECHAT_OFFICIAL_ACCOUNT_REDIRECT_URI`
- `AUTH_DEPLOYED_AT`

Secret 键：

- `LIGHTCLAW_ADMIN_TOKEN`
- `LIGHTCLAW_AUTH_DB_PASSWORD`
- `LIGHTCLAW_COS_BUCKET_URL`
- `LIGHTCLAW_COS_SECRET_ID`
- `LIGHTCLAW_COS_SECRET_KEY`
- `LIGHTCLAW_DEV_SMS_CODE`
- `LIGHTCLAW_MYSQL_DSN`
- `LIGHTCLAW_QQ_APP_KEY`
- `TENCENT_REALNAME_SECRET_ID`
- `TENCENT_REALNAME_SECRET_KEY`
- `TENCENT_REALNAME_ENDPOINT`
- `REALNAME_ENCRYPTION_KEY`
- `LIGHTCLAW_WECHAT_APP_SECRET`
- `LIGHTVELA_WECHAT_OFFICIAL_ACCOUNT_APP_SECRET`
- `MYSQL_DSN`
- `MYSQL_ROOT_PASSWORD`

## Note

`user-auth` namespace 和默认 `ServiceAccount` 已被更早接入的 app 共享持有，所以这只 app 不再试图接管这两个资源。
