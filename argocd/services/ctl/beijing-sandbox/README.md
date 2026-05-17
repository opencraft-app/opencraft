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
- `conf/server_conf.toml`
- `souls/`
- `ctl-conf-rewrite.yaml`
- `../../../secrets/beijing-sandbox/ctl-runtime-secrets.sops.yaml`

## Current Runtime Contract

平台值：

- `CTL_IMAGE`
- `CTL_NODE_POOL`
- `CTL_INTERNAL_SUBNET_ID`
- `CTL_CLS_TOPIC_ID`
- `CTL_DEPLOYED_AT`
- `CTL_TEST_MYSQL_HOST`

加密资源（通过标准 `sops` 文件下发）：

- `Secret/ctl-runtime-secrets`（包含 `CTL_MQ_STREAM_KEY`、`CTL_AIGATEWAY_*`、`AGENTCHAT_*` 等运行时密文）

普通资源：

- `ConfigMap/ctl-conf-common`
- `ConfigMap/ctl-soul-templates`

明文资源：

- `ConfigMap/ctl-conf-rewrite`

`ctl-conf-rewrite.yaml` 只放环境策略和非敏感连接信息。DB password、Redis password 等敏感值必须通过 `ctl-runtime-secrets` 注入，不要再写回 rewrite TOML。

## Note

北京试点后，这个 deploy-facing 目录只保留环境值、SOUL 模板和 secret/config 输入；
`delete-migration-job`、`replacements` 等结构性逻辑统一下沉到 `ctl/k8s/overlays/beijing-sandbox/`。
