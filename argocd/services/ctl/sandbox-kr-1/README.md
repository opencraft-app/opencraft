# CTL Beijing Sandbox

这个目录是 `ctl` 接入北京 GitOps 时的 deploy-facing 入口。

边界：

- source-facing 内容仍留在 `ctl/`
- 统一 Argo CD 控制面通过这个目录把资源下发到北京 `ctl` namespace
- steady-state sync 只接管常驻 workload，不接 migration job

## Files

- `kustomization.yaml`
- `ksops-assets-generator.yaml`
- `ctl-platform.env`
- `souls/`
- `../../../secrets/sandbox-kr-1/ctl-conf-common.sops.yaml`
- `../../../secrets/sandbox-kr-1/ctl-conf-rewrite.sops.yaml`
- `../../../secrets/sandbox-kr-1/ctl-runtime-secrets.sops.yaml`

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
- `Secret/ctl-runtime-secrets`

普通资源：

- `ConfigMap/ctl-soul-templates`

## Note

北京试点后，这个 deploy-facing 目录只保留环境值、SOUL 模板和 secret/config 输入；
`delete-migration-job`、`replacements` 等 source-facing 结构性逻辑当前复用 `ctl/k8s/overlays/beijing-sandbox/`，playground 实例差异只沉淀在本目录的 deploy-facing artifact。
