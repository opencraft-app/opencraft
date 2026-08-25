# Sandbox Singapore Production

这个目录是 `sandbox` 接入新加坡 GitOps 时的 deploy-facing 入口。

边界：

- source-facing 内容仍留在 `sandbox/`
- 统一 Argo CD 控制面通过这个目录把资源下发到新加坡 `sandbox` namespace
- steady-state sync 只接管常驻 workload，不接 migration job

## Files

- `kustomization.yaml`
- `delete-migration-job.yaml`
- `ksops-secret-generator.yaml`
- `sandbox-platform.env`
- `tls-secrets.yaml`
- `../../../secrets/sgprod/sandbox-runtime-secrets.sops.yaml`

## Current Runtime Contract

平台值：

- `SANDBOX_NODE_POOL`
- `SANDBOX_SUPPORT_SUBNET_ID`
- `SANDBOX_REDIS_ADDR`
- `SANDBOX_MYSQL_HOST`
- `TENCENT_REGION`
- `SANDBOX_VPC_ID`
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
- `SANDBOX_API_KEY`：参数化内部 TAT 路由鉴权，必须与 CTL `ctl-runtime-secrets` 中同名值一致

内部参数化 TAT 调用还要求 Sandbox 运行时配置
`WEBSITE_CREDENTIAL_TAT_COMMAND_ID`，并与 CTL 使用的值一致。缺少 API Key、缺少
CommandId 或 CommandId 不匹配时接口默认拒绝；该失败只影响凭据下发，CTL 仍将
已创建实例置为 `Running`。

## Note

`sandbox` 的 steady-state Argo 目录不接 migration job。数据库变更继续走平台级 DB job 入口，而不是常驻 Kustomization。
