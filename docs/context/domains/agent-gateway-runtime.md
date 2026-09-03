---
id: agent-gateway-runtime
type: domain
scope: Agent 执行、网关路由、渠道、模型 provider 与流式行为。
triggers: ["agent", "gateway", "channel", "model", "streaming"]
owner: mingyuxiao
authority: derived
source_of_truth:
  - docs/engineering/domains/agent-gateway-runtime.md
  - cloudagent/AGENTS.md
  - ai-gateway/AGENTS.md
  - service-gateway/README.md
  - service-gateway/internal/gateway
status: active
reviewed_at: 2026-08-25
review_due: 2026-11-23
revision: 2.0.0
precedence: domain
derived: true
---

# Agent、网关与运行时

> 派生摘要：正式领域知识见 `docs/engineering/domains/agent-gateway-runtime.md`；本页只保留影响 Agent 路由和实现决策的最小事实。

## 适用场景

任务变更 agent 调用、公共入口、上游路由、渠道集成、模型选择、provider fallback 或流式行为时使用。

## 影响决策的事实

- `service-gateway` 是公共入口和路由策略层；直连上游不能作为公共路径的等价证据。
- `cloudagent` 负责 agent 运行时行为；`ai-gateway` 与 `velagw` 负责模型/provider 控制面和数据面行为。
- 开始工作前先明确上游归属。不得通过修补网关路由补偿上游 contract bug，也不得修补上游却宣称修复了公共入口。
- 流式和渠道行为必须经实际路由与传输层测试，不能只靠隔离 handler 测试。
- 身份 header 或上游 URL 变更同时影响 auth、归属与可观测性；编辑前检查相应测试。

## 代码锚点

- `service-gateway/internal/gateway/server.go`
- `service-gateway/internal/gateway/server_test.go`
- `cloudagent/`
- `ai-gateway/`
- `velagw/`

## 验证

运行变更服务的聚焦 Go test package。网关路由变更需要上游测试和路由级测试；流式变更需要传输层断言，不能只断言状态码。

## 不得推断

第三方模型 provider 的行为和限额属于外部 authority。加入 provider 特定假设前须登记来源。
