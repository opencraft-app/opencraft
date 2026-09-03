---
id: repository-map
type: project
scope: mono2 仓库及其主要服务组的稳定地图。
triggers: ["repository map", "service lookup", "monorepo navigation"]
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

# 仓库地图

| 区域 | 职责 |
|---|---|
| `frontend/`, `frontend-ds/`, dashboards | 用户界面和设计系统 |
| `user/auth/`, `shadow/` | 身份、会话、实名和影子账户行为 |
| `service-gateway/`, `site-gateway/`, other gateways | 公共入口、路由和上游策略 |
| `subscription/`, `payment/`, `trade/` | 套餐、支付、结算和商业流程 |
| `cloudagent/`, `ai-gateway/`, `velagw/`, `velalink/` | Agent 运行时、模型/provider 平面和聊天运行时 |
| `ctl/`, `sandbox/` | 实例控制和沙箱编排 |
| `infra_pulumi/`, `argocd/`, `.ci/` | 基础设施、GitOps 和交付自动化 |

不得将此地图作为服务 contract 的 authority。最近服务入口和生成 API/运行时源码仍是权威来源。
