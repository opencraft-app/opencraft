# CloudAgent 运行时

`cloudagent` 是一个运行时服务组，不是单一二进制：包含 gateway、ChannelGateway、Wisp runtime、sandbox-host 与 agent-loader。

## 权威入口

- [目录说明](../README.md)、[Agent 约束](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- gateway 细节：`../gateway/README.md`
- [Agent、网关与运行时领域](../../docs/engineering/domains/agent-gateway-runtime.md)

## 发布边界

gateway、ChannelGateway 与 Wisp/runtime artifact 分属不同 CI 触发面。跨两侧的变更必须同时证明 runtime artifact URL/SHA、gateway 镜像 pin、Argo 状态和 `/v1/selfcheck` 报告值；源码进入 `master` 不等于 DevCloud 已更新。

## 验证

在最近子模块运行其 Go/Rust/Node 测试；涉及发布时按 [发布领域](../../docs/engineering/domains/release-gitops.md) 完成制品、GitOps 和运行态三层验收。
