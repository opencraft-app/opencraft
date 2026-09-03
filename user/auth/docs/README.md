# 用户身份与认证

`user/auth` 拥有登录、会话、OIDC/OAuth 和实名相关 contract；网关消费这些状态，但不能另建平行身份判断。

## 权威入口

- [服务说明](../README.md)、[Agent 约束](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- API 真源：`../api/openapi.yaml`
- [身份与访问领域](../../../docs/engineering/domains/identity-access.md)

## 关键边界

migration/seed 不在应用启动路径；运行时 Secret 由 GitOps Secret 管理。实名、会话和授权状态必须从 API/存储契约读取，不通过前端 local state 推断。

## 验证

运行 `go test ./...`，覆盖登录、会话过期、实名状态、回调验证与权限失败；公共行为还要经 `service-gateway` 验证。
