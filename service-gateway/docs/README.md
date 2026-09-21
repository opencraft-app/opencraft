# 公共 Service Gateway

`service-gateway` 是国内/国际站公共 API 的入口层，组合站点路由、鉴权与后端 upstream；它不拥有被代理服务的业务状态。

## 权威入口

- [服务说明](../README.md)、[Agent 约束](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- 路由代码：`../internal/gateway/`
- [账号到 Agent Journey](../../docs/engineering/journeys/account-to-agent.md)

## 关键边界

公共路径验证不能被后端直连替代。`admin-gateway` 有独立流水线和镜像，不能通过本服务夹带发布。`platform.env` 是 infra 派生输入，运行时 Secret 走 GitOps Secret 主线。

## Collaboration upstream

OpenCraft 通过现有 LightVela 账户会话访问 Collaboration，不增加第二套登录账户。启用组件时，在目标环境生成的 gateway 配置中加入：

```yaml
collaboration:
  upstream: http://collaboration.lightvela-collaboration.svc.cluster.local
  upstream_bearer_token_env: COLLABORATION_GATEWAY_TOKEN
  allowed_origins:
    - http://localhost:*
    - http://127.0.0.1:*
```

`service-gateway-runtime-secrets` 中的 `COLLABORATION_GATEWAY_TOKEN` 必须与 Collaboration Secret 挂载的 `gateway.token` 相同。Gateway 先校验 Human 会话、覆盖调用方伪造的身份头，再将 `/v1/collaboration` 重写为 `/v1` 并使用内部 Bearer 请求上游。内置 allowlist 不开放旧的外部 Computer/TAT bootstrap surface。
北京首次接线由 Collaboration SSM 的同一个 `gateway.token` 只投影出专用
`collaboration-gateway-token` Secret，不复制数据库或 IM 密钥。配置 Collaboration upstream
但缺少该环境变量时，Gateway 必须启动失败，不能以 Healthy Pod 承载稳定 `502`。
`allowed_origins` 必须限定本地预览和明确产品域名，不能继承北京环境的全局 `*`。

## 验证

运行 `go test ./...`，并对每个路由变更验证目标站点、鉴权/实名失败、上游成功与错误传播；发布另核对独立 Argo 应用。
