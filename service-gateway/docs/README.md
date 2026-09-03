# 公共 Service Gateway

`service-gateway` 是国内/国际站公共 API 的入口层，组合站点路由、鉴权与后端 upstream；它不拥有被代理服务的业务状态。

## 权威入口

- [服务说明](../README.md)、[Agent 约束](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- 路由代码：`../internal/gateway/`
- [账号到 Agent Journey](../../docs/engineering/journeys/account-to-agent.md)

## 关键边界

公共路径验证不能被后端直连替代。`admin-gateway` 有独立流水线和镜像，不能通过本服务夹带发布。`platform.env` 是 infra 派生输入，运行时 Secret 走 GitOps Secret 主线。

## 验证

运行 `go test ./...`，并对每个路由变更验证目标站点、鉴权/实名失败、上游成功与错误传播；发布另核对独立 Argo 应用。
