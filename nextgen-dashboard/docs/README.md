# Nextgen Dashboard

本服务提供下一代网关管理面的后端/页面能力，运行和发布责任与 `gateway-dashboard` 分开记录。

## 权威入口

- [服务说明](../README.md)、[Agent 约束](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- [服务拓扑](../../docs/engineering/architecture/service-topology.md)
- source-facing 清单：`../k8s/`

## 关键边界

环境 runtime Secret 走 `SSM → sops → ksops`，不提交 `generated/`。服务源码和 Kustomize 只描述期望状态，正式发布由独立 Argo 应用确认。

## 验证

运行 Go 测试/build，验证管理 API 及上游依赖；交付时核对独立镜像 pin 与 Argo revision。
