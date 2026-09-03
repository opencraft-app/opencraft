# AI Gateway 工程入口

本服务拥有模型请求进入 provider 之前的网关行为；供应商协议、流式语义和路由回退必须由运行时代码与测试证明。

## 权威入口

- [服务说明](../README.md)、[Agent 约束](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- [开发指南](../../docs/agent-guides/ai-gateway-agent-guide.md)
- [Agent、网关与运行时领域](../../docs/engineering/domains/agent-gateway-runtime.md)

## 关键边界

`gateway-dashboard` 是独立管理前端；数据库 migration 由仓库级 GitOps job 工具负责，不放回应用启动链路。服务内 Kustomize 是 source-facing，生产运行态由 Argo CD 决定。

## 验证

按变更覆盖协议适配、流式/非流式响应、失败回退和路由测试，并运行服务 lint/build/test。发布验收另核对镜像与 Argo 状态。
