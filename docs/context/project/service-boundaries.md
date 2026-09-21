---
id: service-boundaries
type: project
scope: 跨服务归属、调用关系与集成边界。
triggers: ["cross service", "boundary", "ownership", "integration"]
owner: mingyuxiao
authority: derived
source_of_truth:
  - AGENTS.md
  - .agents/context/context-routing.yaml
status: active
reviewed_at: 2026-08-25
review_due: 2026-11-23
revision: 2.0.0
precedence: project
derived: true
---

# 服务边界

1. 身份状态归 `user/auth`；网关执行路由策略，但不能成为身份来源。
2. 支付订单状态归 `payment`；订阅状态通过内部 apply-payment contract 更新。
3. 公共入口行为归网关服务；直连上游测试不能替代公共路由验证。
4. Agent 运行时行为归 `cloudagent`；模型/provider 平面行为归 `ai-gateway` 或 `velagw`。
5. 部署事实分离：源码 manifest 在服务下，线上面向部署的 manifest 在 `argocd/` 下。

任务跨越两个边界时，创建一个只有一个主要目标的 Task Pack，并在 `affected_paths` 中列出次要边界。不得在两个服务入口创建相互竞争的指令。
