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
reviewed_at: 2026-09-14
review_due: 2026-11-23
revision: 2.1.0
precedence: project
derived: true
---

# 仓库地图

| 区域 | 职责 |
|---|---|
| `frontend/`, `frontend-ds/`, dashboards | 用户界面和设计系统 |
| `opencraft/` | OpenCraft 应用、Workbench、平台能力和 first-party 插件唯一写入真源 |
| `collaboration/` | Server/Member/Channel、腾讯 IM 资源映射和协作业务控制面 |
| `vela-computer/` | 下发到托管 Computer 的 Agent Chat Client；不属于 `cloudagent/` |
| `shared/` | 跨服务、跨客户端的中立产品内核与契约 |
| `user/auth/`, `shadow/` | 身份、会话、实名和影子账户行为 |
| `service-gateway/`, `site-gateway/`, other gateways | 公共入口、路由和上游策略 |
| `subscription/`, `payment/`, `trade/`, `credit/` | 套餐、支付、结算、积分包和商业流程 |
| `cloudagent/`, `ai-gateway/`, `velagw/`, `velalink/` | Agent 运行时、模型/provider 平面和聊天运行时 |
| `shared/` | 跨 Web、OpenCraft 与移动端的 renderer-neutral 产品内核；每个包由最近的 `AGENTS.md` 约束 |
| `ctl/`, `sandbox/` | 实例控制和沙箱编排 |
| `infra_pulumi/`, `argocd/`, `.ci/` | 基础设施、GitOps 和交付自动化 |

不得将此地图作为服务 contract 的 authority。最近服务入口和生成 API/运行时源码仍是权威来源。

## OpenCraft 与 Collaboration 落点

OpenCraft 已完成一次性历史导入，`git.woa.com/wisp/mono2.git` 是唯一可写真源；不得把
`opencraft/`、`collaboration/`、`vela-computer/` 或 `shared/vela-chat-client-core/` 双写到旧
checkout。`/Users/skipzhang/code/mono2-clean4` 仅是本机旧工作区，不是这些目录的集成真源。
