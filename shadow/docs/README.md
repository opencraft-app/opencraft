# Shadow Account 集成

本服务编排腾讯云影子账号注册、一次性 `auth_code`、临时凭据、试用订单和手机号回滚；默认 fake 模式用于本地验证。

## 权威入口

- [运行说明](../README.md)、[Agent 约束](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- [架构设计](../ARCHITECTURE.md)
- [身份与访问领域](../../docs/engineering/domains/identity-access.md)

## 关键边界

公共 HTTP contract 与腾讯云回调协议保持一致。平台、计费和存储都在 interface 后实现；真实 endpoint 与凭据不写进默认配置或文档。本地 Polaris stub 在内部依赖不可用时是构建边界，不可无证据移除。

## 验证

运行 `go test ./...`，覆盖 fake/mock/真实 adapter 的契约、一次性授权码、幂等订单、失败回滚和 callback 鉴权；真实外部调用需单独授权。
