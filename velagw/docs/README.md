# VelaGW / LLMGateway

`velagw` 是从 `wisp/velagw` 导入的 squash subtree，包含 LLMGateway 控制面、数据面和 Web 管理端。

## 权威入口

- [上游 README](../README.md)、[Agent 约束](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- [Subtree 契约](../MONO2_SUBTREE.md)
- [Agent、网关与运行时领域](../../docs/engineering/domains/agent-gateway-runtime.md)

## 关键边界

共享变更通过 `git subtree split --prefix=velagw` 回流。嵌入 mono2 不等于已接入 mono2 发布链；provider contract 没有路由测试时，不用本地兼容 shim 绕过。

## 验证

运行最近 Go package/Makefile 与 Web 门禁，检查上游 pin、mono2 集成差异和 provider 路由；发布状态独立验证。
