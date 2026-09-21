# Temporal Workers

`workers` 承载 Temporal workflow/activity 运行时以及 rescue exporter/uploader。变更必须保护 workflow determinism、补偿路径和可回滚部署。

## 权威入口

- [服务说明](../README.md)、[Agent 约束](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- [服务拓扑](../../docs/engineering/architecture/service-topology.md)
- source-facing 清单：`../k8s/`

## 关键边界

Temporal、腾讯云和 COS 凭据只通过运行时 Secret 提供，不作为命令行参数。`TEMPORAL_DEPLOYMENT_NAME` 与 `TEMPORAL_WORKER_BUILD_ID` 必须成对配置。生产镜像同时包含 exporter/uploader，不在运行时编译。

## 验证

在 `workers/` 运行 `go test ./...` 与 `go vet ./...`；workflow 变更增加 replay/determinism 和补偿测试，容器变更在 Docker 可用时构建镜像。
