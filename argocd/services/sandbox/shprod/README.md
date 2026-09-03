# Sandbox Shanghai Production

这个目录是 `sandbox` 接入上海 GitOps 时的 deploy-facing 入口。

边界：

- source-facing 内容仍留在 `sandbox/`
- 统一 Argo CD 控制面通过这个目录把资源下发到上海 `sandbox` namespace
- steady-state sync 只接管常驻 workload，不接 migration job

## Files

- `kustomization.yaml`
- `delete-migration-job.yaml`
- `ksops-secret-generator.yaml`
- `sandbox-platform.env`
- `tls-secrets.yaml`
- `../../../secrets/shprod/sandbox-runtime-secrets.sops.yaml`

## Current Runtime Contract

平台值：

- `SANDBOX_NODE_POOL`
- `SANDBOX_SUPPORT_SUBNET_ID`
- `SANDBOX_REDIS_ADDR`
- `SANDBOX_MYSQL_HOST`
- `TENCENT_REGION`
- `SANDBOX_VPC_ID`
- `WEBSITE_CREDENTIAL_TAT_COMMAND_ID`：上海参数化 TAT Command allowlist
- `SANDBOX_INGRESSPROXY_PUBLIC_HOST`
- `SANDBOX_INGRESSPROXY_HEALTHCHECK_HOST`
- `SANDBOX_INGRESSPROXY_TLS_SECRET_NAME`
- `SANDBOX_API_IMAGE`
- `SANDBOX_MIGRATE_IMAGE`
- `SANDBOX_WORKER_IMAGE`
- `SANDBOX_INGRESSPROXY_ROUTER_IMAGE`
- `SANDBOX_INGRESSPROXY_SHARD_IMAGE`
- `SANDBOX_API_DEPLOYED_AT`
- `SANDBOX_WORKER_DEPLOYED_AT`

Secret 键：

- `MYSQL_USER`
- `MYSQL_PASSWORD`
- `REDIS_PASSWORD`
- `TENCENT_SECRET_ID`
- `TENCENT_SECRET_KEY`
- `SANDBOX_API_KEY`：必须与上海 CTL `ctl-runtime-secrets` 中同名值一致

内部参数化 TAT 路由同时校验 `SANDBOX_API_KEY` 和
`WEBSITE_CREDENTIAL_TAT_COMMAND_ID`。缺少密钥、缺少 CommandId 或 CommandId 不匹配时
请求默认拒绝；该失败只影响建站凭据下发，CTL 仍会保留已成功创建的实例。

## Note

`sandbox` 的 steady-state Argo 目录不接 migration job。数据库变更继续走平台级 DB job 入口，而不是常驻 Kustomization。
