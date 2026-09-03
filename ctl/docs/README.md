# CTL 控制面

CTL 拥有实例、渠道及编排逻辑；公共 `/v1/instances` 行为还经过网关，直连 CTL 只证明服务内部行为。

## 权威入口

- [服务说明](../README.md)、[Agent 约束](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- [CTL 开发指南](../../docs/agent-guides/ctl-agent-guide.md)
- [控制面相关服务拓扑](../../docs/engineering/architecture/service-topology.md)

## 关键边界

实例归属、地域和状态来自权威存储，不从名称推断。路由或上游变更必须同时覆盖直连上游与公共网关；渠道配置和实例归属变更保持可分别审阅。

## 验证

在 `ctl/` 运行 `go test ./...`；跨服务变更同时执行相应 Journey 的验证，并在交付时区分源码、GitOps 与真实运行态证据。
