# Session Argo CD Cutover

这份 runbook 只覆盖 `session` 北京测试环境接入香港中心 Argo 的步骤。

## Current State

当前北京现网已经有：

- namespace: `user-auth`
- deployment: `session`
- service: `session`
- configmap: `session-config`
- secret: `session-runtime-secrets`

## Inputs To Preserve

平台值：

- `SESSION_IMAGE`
- `SESSION_NODE_POOL`
- `SESSION_ALLOWED_ORIGINS`
- `SESSION_DEPLOYED_AT`

Secret：

- `SESSION_DB_PASSWORD`
- `SESSION_MYSQL_DSN`
