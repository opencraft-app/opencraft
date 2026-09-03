# Gateway Dashboard

本应用是网关管理面前端，公网访问必须经过 `admin-gateway`；历史 direct-access 不是当前正式链路。

## 权威入口

- [服务说明](../README.md)、[Agent 约束](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- [开发指南](../../docs/agent-guides/gateway-dashboard-agent-guide.md)
- [Agent、网关与运行时领域](../../docs/engineering/domains/agent-gateway-runtime.md)

## 关键边界

管理 UI 不拥有 provider/路由执行语义，后端 contract 与错误状态必须保持可追溯。发布链路与 AI Gateway 独立，`generated/` 不提交。

## 验证

按 `package.json` 运行 lint、typecheck、test 和 build；再验证通过 `admin-gateway` 的入口、鉴权失败和管理 API 兼容性。
