# Infra Pulumi Secrets

Infrastructure secrets must not be committed.

Preferred injection order:

1. Pulumi config secrets when the value belongs to a shared stack
2. shell environment variables for short-lived local runs that populate Pulumi secret config
3. repo-root untracked `secrets.local.sh` only as a local convenience bridge for Tencent Cloud API credentials

Required Tencent Cloud API credentials:

```bash
export TENCENTCLOUD_SECRET_ID='...'
export TENCENTCLOUD_SECRET_KEY='...'
```

Recommended stack secrets:

```bash
export NODE_PASSWORD='...'
export DB_PASSWORD='...'
export REDIS_PASSWORD='...'
cd infra_pulumi
GOWORK=off go run ./cmd/infractl set-secrets --stack beijing-sandbox
```

Never commit:

- local secret files
- shell scripts with inline production credentials
- Pulumi state directories or exported checkpoints
- generated files that contain secret values

Note:

- `deploy/envs/<env>/platform.env` is now a generated sensitive file because `infractl sync/up` writes deploy runtime passwords into it for downstream rollout workflows.
- Treat `platform.env` like a local secret artifact even though it is repo-local.

`cmd/infractl` supports reading repo-root untracked `secrets.local.sh` for local API credentials and local fallback values, but managed resource passwords now come from Pulumi stack secrets:

- `infra-pulumi:nodePassword`
- `infra-pulumi:dbPassword`
- `infra-pulumi:redisPassword`
