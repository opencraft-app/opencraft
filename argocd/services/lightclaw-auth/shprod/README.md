# Lightclaw Auth Shanghai Production

这个目录是 `lightclaw-auth` 接入上海 GitOps 时的 deploy-facing 入口。

边界：

- source-facing 内容仍留在 `user/auth/`
- 统一 Argo CD 控制面通过这个目录把资源下发到上海 `user-auth` namespace
- 第一阶段保留当前线上 Deployment / Service / internal LB 语义，但显式不接 migration / seed job

## Files

- `kustomization.yaml`
- `delete-jobs.yaml`
- `delete-shared-bootstrap.yaml`
- `ksops-secret-generator.yaml`
- `ksops-shadow-runtime-secret-generator.yaml`
- `realname-faceid-reconciliation-worker.yaml`
- `auth-platform.env`
- `../../../secrets/shprod/lightclaw-auth-secrets.sops.yaml`
- `../../../secrets/shprod/shadow-runtime-secrets.sops.yaml`

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
- `AUTH_FEDERATION_ENABLED=true`
- `AUTH_FEDERATION_ENVIRONMENT=shprod`
- `AUTH_FEDERATION_ACTIVE_AEAD_KEY_ID=federation-sh-20260825-1`
- `AUTH_FEDERATION_CTL_BASE_URL=http://ctl-api.ctl.svc.cluster.local`
- `AUTH_FEDERATION_TAT_TIMEOUT_SECONDS=5`
- `AUTH_FEDERATION_DELEGATED_SESSION_TTL_SECONDS=28800`
- `LIGHTCLAW_REALNAME_ASSURANCE_MODE=faceless` keeps the FaceID attempt state machine while skipping face capture.
- `SHADOW_BASIC_AUTH_SYNC_ENABLED=true` keeps phone proof and Shadow synchronization in the verification chain.

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
- `TENCENT_REALNAME_FACEID_RULE_ID`
- `TENCENT_REALNAME_ACCOUNT_ID`
- `TENCENT_REALNAME_FACEID_REDIRECT_URL`
- `REALNAME_ENCRYPTION_KEY`
- `LIGHTCLAW_WECHAT_APP_SECRET`
- `LIGHTVELA_WECHAT_OFFICIAL_ACCOUNT_APP_SECRET`
- `MYSQL_DSN`
- `MYSQL_ROOT_PASSWORD`
- `LIGHTCLAW_OIDC_SIGNING_KEYS_JSON`
- `LIGHTCLAW_FEDERATION_AEAD_KEYS_JSON`
- `LIGHTCLAW_FEDERATION_NONCE_KEY`
- `LIGHTCLAW_FEDERATION_CLIENTS_JSON`

Federation client `personal-site` must use key ID `federation-client-sh-20260825-1`, permit only
the callback path `/auth/lightvela/callback` under `dsh.lightvela.tech` subdomains, and share its
HMAC key with `mono-shprod-site-gateway-secrets`.

Shadow runtime secret keys used by the reconciliation worker:

- `SHADOW_SECRET_ID`
- `SHADOW_SECRET_KEY`
- `CLOUDLADDER_SHADOW_HMAC_SECRET`
- `SHADOW_TENCENT_CALLBACK_TOKEN`

## Note

`user-auth` namespace 和默认 `ServiceAccount` 已被更早接入的 app 共享持有，所以这只 app 不再试图接管这两个资源。
