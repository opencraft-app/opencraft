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
- `ctl-conf-rewrite.yaml`
- `../../../secrets/shprod/ctl-runtime-secrets.sops.yaml`
- `../../../secrets/shprod/ctl-conf-common.sops.yaml`

## Current Runtime Contract

平台值：

- `CTL_IMAGE`
- `CTL_NODE_POOL`
- `CTL_INTERNAL_SUBNET_ID`
- `CTL_CLS_TOPIC_ID`
- `CTL_DEPLOYED_AT`
- `CTL_TEST_MYSQL_HOST`
- `WEBSITE_AGENT_API_BASE`：机器侧建站 API 根地址，固定为 `https://api.lightvela.com`
- `WEBSITE_CREDENTIAL_TAT_COMMAND_ID`：上海参数化 TAT CommandId；未配置时自动下发保持关闭

加密资源（通过标准 `sops` 文件下发）：

- `ConfigMap/ctl-conf-common`
- `Secret/ctl-runtime-secrets`

`ctl-runtime-secrets` 必须包含 `SANDBOX_API_KEY`，并与上海 Sandbox
`sandbox-runtime-secrets` 中的同名值完全一致。CTL 调用参数化内部 TAT 接口时通过
`X-API-Key` 发送；缺失或不一致只会导致建站凭据下发失败，不影响实例创建完成。

明文资源：

- `ConfigMap/ctl-conf-rewrite`

`ctl-conf-rewrite.yaml` 只放环境策略和非敏感连接信息。DB password、Redis password 等敏感值必须通过 `ctl-runtime-secrets` 注入，不要再写回 rewrite TOML。

新实例建站凭据下发是 best-effort：CTL 在实例进入 `Running` 后签发实例级 `vik_`，
再通过 Sandbox 调用固定 TAT Command，将 `VELA_WEBSITE_KEY` 和国内
`VELA_API_BASE` 写入子机。签发或下发失败时撤销本次 Key，实例仍保持创建成功，后续可补发。

## Note

`ctl` 的 steady-state Argo 目录不接 migration job。数据库变更继续走平台级 DB job 入口，而不是常驻 Kustomization。

## CI Trigger Notes

- 2026-05-17T19:51:27Z: trigger ctl release pipeline after runtime DB secret plaintext fix.
- 2026-05-30T03:36:00Z: trigger ctl release pipeline for reset-config backend rollout.
