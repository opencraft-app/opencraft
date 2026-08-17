# CTL Singapore Production

这个目录是 `ctl` 接入新加坡 GitOps 时的 deploy-facing 入口。

边界：

- source-facing 内容仍留在 `ctl/`
- 统一 Argo CD 控制面通过这个目录把资源下发到新加坡 `ctl` namespace
- steady-state sync 只接管常驻 workload，不接 migration job

## Files

- `kustomization.yaml`
- `delete-migration-job.yaml`
- `ksops-assets-generator.yaml`
- `ctl-platform.env`
- `ctl-conf-rewrite.yaml`
- `../../../secrets/sgprod/ctl-conf-common.sops.yaml`
- `../../../secrets/sgprod/ctl-runtime-secrets.sops.yaml`
- `../../../secrets/sgprod/ctl-website-runtime-secrets.sops.yaml`

## Current Runtime Contract

平台值：

- `CTL_IMAGE`
- `CTL_NODE_POOL`
- `CTL_INTERNAL_SUBNET_ID`
- `CTL_CLS_TOPIC_ID`
- `CTL_DEPLOYED_AT`
- `CTL_TEST_MYSQL_HOST`

加密资源（通过标准 `sops` 文件下发）：

- `ConfigMap/ctl-conf-common`
- `Secret/ctl-runtime-secrets`
- `Secret/ctl-website-runtime-secrets`

明文资源：

- `ConfigMap/ctl-conf-rewrite`

`ctl-conf-rewrite.yaml` 只放环境策略和非敏感连接信息，例如默认
`template_class_id` / `sku_id`、服务地址、超时和限额。DB password、Redis
password、shadow token 等敏感值必须通过 `ctl-runtime-secrets` 注入，不要再写回
rewrite TOML。

建站能力单独使用 `ctl-website-runtime-secrets`，包含：

- `CTL_INTERNAL_TOKEN`：签发实例级建站 key 的内部接口鉴权
- `WEBSITE_INTERNAL_API_TOKEN`：CTL、site-gateway、website-deployer 之间的内部鉴权
- `WEBSITE_COS_BUCKET` / `WEBSITE_COS_REGION`
- `WEBSITE_COS_SECRET_ID` / `WEBSITE_COS_SECRET_KEY`

## Note

`ctl` 的 steady-state Argo 目录不接 migration job。数据库变更继续走平台级 DB job 入口，而不是常驻 Kustomization。
