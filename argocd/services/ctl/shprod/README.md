# CTL Shanghai Production

这个目录是 `ctl` 接入上海 GitOps 时的 deploy-facing 入口。

边界：

- source-facing 内容仍留在 `ctl/`
- 统一 Argo CD 控制面通过这个目录把资源下发到上海 `ctl` namespace
- steady-state sync 只接管常驻 workload，不接 migration job

## Files

- `kustomization.yaml`
- `delete-migration-job.yaml`
- `ksops-assets-generator.yaml`
- `ctl-platform.env`
- `../../../secrets/shprod/ctl-conf-common.sops.yaml`
- `../../../secrets/shprod/ctl-conf-rewrite.sops.yaml`

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
- `ConfigMap/ctl-conf-rewrite`

## Note

`ctl` 的 steady-state Argo 目录不接 migration job。数据库变更继续走平台级 DB job 入口，而不是常驻 Kustomization。
