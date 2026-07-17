# Proposal: LLMGateway new-api drop-in old ai-gateway

## Why

old ai-gateway 同时承担 LLM 流量、积分/订阅投影、key 管理和部分运营接口。new-api 已经具备更强的 provider relay、channel、token、subscription 和扣费能力，但它是单 Set 系统，不负责 mono2 平台的多 Set 和迁移语义。

我们需要 LLMGateway 在不改 new-api 的前提下，把 new-api 作为执行面纳入 mono2，并让 old 用户和新用户可以平滑并行。

## What

本变更定义 LLMGateway 的平台规格：

- 多 Set 纳管；
- Tenant 主表和 assignment 兼容入口；
- platform plan 到 new-api plan 映射；
- subscription/credit facade；
- 外部 key 到 upstream key 路由；
- /v1/* 流量代理；
- old ai-gateway fallback；
- channel desired state 和 drift 管理；
- 管理台 OpenAPI 契约；
- E2E 和生产化验证要求。

## Non-goals

- 不修改 new-api。
- 不复制 new-api 数据库。
- 不重建完整 LLM 账本。
- 不完整复刻 old ai-gateway dashboard。
- 不自动跨 Set 迁移已存在 new-api 用户。

## Compatibility

old 用户默认仍走 old ai-gateway。new 用户通过 Tenant 主表和 key binding 走目标 Set。ctl/trade 可以逐步把 base URL 切到 LLMGateway，通过 allowlist fallback 保持 old/new 并行。
