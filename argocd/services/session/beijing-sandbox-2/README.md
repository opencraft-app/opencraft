# Session Beijing Sandbox

这个目录是 `session` 接入北京 GitOps 时的 deploy-facing 入口。

边界：

- source-facing 内容在 `session/`
- 香港 Argo 通过这个目录把资源下发到北京 `user-auth` namespace
- 第一阶段完全按北京现网 Deployment / Service / ConfigMap / Secret 模板接入

## Files

- `kustomization.yaml`
- `ksops-secret-generator.yaml`
- `session-platform.env`
- `../../../secrets/beijing-sandbox-2/session-runtime-secrets.sops.yaml`

## Current Runtime Contract

平台值：

- `SESSION_IMAGE`
- `SESSION_NODE_POOL`
- `SESSION_ALLOWED_ORIGINS`
- `SESSION_DEPLOYED_AT`

Secret 键：

- `SESSION_DB_PASSWORD`
- `SESSION_MYSQL_DSN`
