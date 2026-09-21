# CloudAgent 运行说明

本目录负责 CloudAgent gateway、ChannelGateway、Wisp runtime package、sandbox-host、agent-loader 及相关运行时产物。

## DevCloud 发布触发条件

CloudAgent code commit 进入 `master` 不代表 DevCloud 自动更新。始终检查拥有该变更代码的发布面：

- `cloudagent/gateway/**` 或 `cloudagent/sandbox-host/**` 会触发
  `.ci/cloudagent-gateway.yml`, which builds and pins the
  `cloudagent-gateway` image for `devcloud-dep`.
- `cloudagent/channelgateway/**` 会触发 `.ci/channelgateway.yml`，它
  builds and pins the `channelgateway` image for `devcloud-dep`.
- `cloudagent/wisp/**`、`cloudagent/research/hermes-rs/**` 和
  `cloudagent/agent-loader/**` trigger `.ci/cloudagent-agent-artifact.yml`,
  which builds and uploads CloudAgent runtime artifacts to Shanghai COS.

变更同时涉及 Wisp/runtime artifact 和 gateway 行为时，验证以下两侧：

1. runtime artifact CI 产出了新的 Wisp/sidecar artifact URL 和 SHA。
2. `argocd/services/cloudagent-gateway/devcloud-dep/cloudagent-gateway-platform.env`
   has been pinned to the desired gateway image and Wisp artifact URL.
3. Argo `cloudagent-gateway-devcloud-dep` 为 `Synced / Healthy`。
4. DevCloud 内部 endpoint 的 `GET /v1/selfcheck` 报告预期 sidecar/Wisp artifact 值。

需要重建 gateway image 但源码未触及 gateway 所有的 watched path 时，按既有 CI trigger-note 约定，在 `cloudagent/gateway/README.md` 的 `CI trigger notes` 下添加带日期的 no-op 行。需要重建 Wisp artifact 时，触及 Wisp 所有的 watched path，例如本文件或 `cloudagent/wisp/AGENTS.md`。
