# Lightclaw Auth Argo CD Cutover

这份 runbook 只覆盖 `lightclaw-auth` 北京测试环境接入统一 Argo CD 控制面 的步骤。

## Current State

当前北京现网已经有：

- namespace: `user-auth`
- deployment: `lightclaw-auth`
- services:
  - `lightclaw-auth`
  - `lightclaw-auth-internal`
- configmaps:
  - `lightclaw-auth-config`
  - `auth-platform-values`
- secret:
  - `lightclaw-auth-secrets`

## Source-facing Caveat

仓库里的 `user/auth/k8s/base` 带 migration job 和 seed job。

北京首轮接入规则：

- Deployment / Service / ConfigMap / Secret 先纳管
- migration / seed job 先不纳入 root app

## Inputs To Preserve

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
- `AUTH_DEPLOYED_AT`

Secret：

- `LIGHTCLAW_ADMIN_TOKEN`
- `LIGHTCLAW_AUTH_DB_PASSWORD`
- `LIGHTCLAW_COS_BUCKET_URL`
- `LIGHTCLAW_COS_SECRET_ID`
- `LIGHTCLAW_COS_SECRET_KEY`
- `LIGHTCLAW_DEV_SMS_CODE`
- `LIGHTCLAW_MYSQL_DSN`
- `LIGHTCLAW_QQ_APP_KEY`
- `LIGHTCLAW_WECHAT_APP_SECRET`
- `MYSQL_DSN`
- `MYSQL_ROOT_PASSWORD`
