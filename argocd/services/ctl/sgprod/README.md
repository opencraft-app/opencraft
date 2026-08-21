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
- `WEBSITE_AGENT_API_BASE`：机器侧建站 API 根地址，当前为 `https://api.lightvela.ai`
- `WEBSITE_CREDENTIAL_TAT_COMMAND_ID`：生产地域参数化 TAT CommandId；未配置时自动下发保持关闭

加密资源（通过标准 `sops` 文件下发）：

- `ConfigMap/ctl-conf-common`
- `Secret/ctl-runtime-secrets`
- `Secret/ctl-website-runtime-secrets`

`ctl-runtime-secrets` 还需要 `SANDBOX_API_KEY`。它必须与 Sandbox
`sandbox-runtime-secrets` 中的同名值完全一致，CTL 调用参数化内部 TAT 接口时通过
`X-API-Key` 发送；未配置或不一致时自动凭据下发失败，但实例创建继续完成。

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

新实例的建站凭据下发是 best-effort：只有 `WEBSITE_AGENT_API_BASE` 和
`WEBSITE_CREDENTIAL_TAT_COMMAND_ID` 同时存在才启用。CTL 先将实例置为 `Running`，
再签发 15 分钟临时 `vik_`；TAT 成功后才永久化。签发、TAT 或永久化失败时主动撤销
本次 Key，进程崩溃或撤销失败由 TTL 兜底，后续可重新签发补下发。
当前不能填写假 CommandId；生产 TAT Command 创建并验收后再补入 `ctl-platform.env`。
同一个 CommandId 还必须以 `WEBSITE_CREDENTIAL_TAT_COMMAND_ID` 配到 Sandbox 运行时；
Sandbox 未配置或不一致时会拒绝调用，不允许退化为任意 TAT Command 代理。
既有 `exec-stream` 客户端也会携带同一 header，但服务端强制校验要等所有地域双端
Secret 都预置后再单独收紧，避免跨地域滚动发布期间造成持续 401。

## Note

`ctl` 的 steady-state Argo 目录不接 migration job。数据库变更继续走平台级 DB job 入口，而不是常驻 Kustomization。
