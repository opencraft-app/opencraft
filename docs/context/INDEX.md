---
id: repository-context-index
type: project
scope: 仓库 Context 的入口与加载契约。
triggers: ["repository context", "routing", "context pack", "task context"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - .agents/context/context-routing.yaml
  - AGENTS.md
  - docs/engineering/README.md
  - docs/engineering/catalog/services.yaml
status: active
reviewed_at: 2026-08-26
review_due: 2026-11-24
revision: 3.0.0
precedence: project
derived: true
---

# 仓库 Context 索引

此目录是 Project Context 来源，不是默认的全量 Context bundle。
默认不要读取本索引。

## 加载顺序

1. 运行 `python3 .agents/context/scripts/validate_context.py --route "<task>"`。
2. 用一条命令仅读取路由得到的 `must_read` 文件和最近服务的 `AGENTS.md`。
3. 仅当任务触及确切边界时，读取 `deferred_paths` 文件。
4. 对定位、修复或历史改动，先在路由相关目录执行一次有界精确搜索；再从 [实现邻接卡索引](project/adjacency/README.md) 选择一张相关卡，检查一个测试、生成物、配置或部署邻居。邻接卡不能充当文件候选或替代源码。
5. 为非简单工作创建或恢复 Task Pack。
6. 在 `context_receipt` 中记录每份实际读取的 context 文件。

## 运行时 Domain

| Pack | 用途 |
|---|---|
| [identity-access](domains/identity-access.md) | 登录、会话、实名和路由授权 |
| [subscription-entitlements](domains/subscription-entitlements.md) | 套餐、pass、续费、配额和支付回调 |
| [agent-gateway-runtime](domains/agent-gateway-runtime.md) | Agent 运行时、入口、渠道、模型和流式处理 |
| [site-environment-routing](domains/site-environment-routing.md) | 国内/国际站、环境和 locale |
| [release-gitops](domains/release-gitops.md) | 构建、晋级、GitOps、Argo 和线上验证 |

一个主任务目标可能需要多个 Domain Pack。路由器返回所有必需 Pack；不得为了强行得到单 Pack 结果而丢弃身份、权益、站点或发布约束。

五个 Domain Pack 均从 `docs/engineering/domains/` 的正式工程文档派生；这里不再作为人读领域知识的唯一真源。

## 服务 Context

23 个主要服务都具有独立 service route，路径命中时加载对应派生 Pack，再按根入口规则读取最近的服务 `AGENTS.md`。正式服务知识在 `<service>/docs/README.md`，机器目录记录在 `<service>/catalog-info.yaml`。

| 服务 | Pack | 服务 | Pack |
|---|---|---|---|
| `.ci` | [ci](project/services/ci.md) | `admin-gateway` | [admin-gateway](project/services/admin-gateway.md) |
| `ai-gateway` | [ai-gateway](project/services/ai-gateway.md) | `cloudagent` | [cloudagent](project/services/cloudagent.md) |
| `cloudladdergateway` | [cloudladdergateway](project/services/cloudladdergateway.md) | `codesign` | [codesign](project/services/codesign.md) |
| `ctl` | [ctl](project/services/ctl.md) | `frontend` | [frontend](project/services/frontend.md) |
| `gateway-dashboard` | [gateway-dashboard](project/services/gateway-dashboard.md) | `infra_pulumi` | [infra-pulumi](project/services/infra-pulumi.md) |
| `new-api` | [new-api](project/services/new-api.md) | `nextgen-dashboard` | [nextgen-dashboard](project/services/nextgen-dashboard.md) |
| `payment` | [payment](project/services/payment.md) | `sandbox` | [sandbox](project/services/sandbox.md) |
| `service-gateway` | [service-gateway](project/services/service-gateway.md) | `shadow` | [shadow](project/services/shadow.md) |
| `subscription` | [subscription](project/services/subscription.md) | `ticket` | [ticket](project/services/ticket.md) |
| `trade` | [trade](project/services/trade.md) | `user/auth` | [user-auth](project/services/user-auth.md) |
| `velagw` | [velagw](project/services/velagw.md) | `velalink` | [velalink](project/services/velalink.md) |
| `workers` | [workers](project/services/workers.md) |  |  |

## 补充 Project 路由

| 路由 | 用途 |
|---|---|
| [project-overview](project/overview.md) | 仅在系统边界、模块关系、数据模型或当前跨服务决策需要时加载 |
| [playground-environment](runbooks/playground-environment.md) | 创建、诊断、修复、扩容或移除北京 playground |
| [product-skill-sync](runbooks/product-skill-subtree-sync.md) | 在 mono2 编写 Product Skills 并同步下游 subtree |
| [tapd-gongfeng-delivery](flows/tapd-gongfeng-delivery.md) | 解析 TAPD ID 并执行分支/MR 交付门禁 |
| [upstream-subtrees](project/upstream-subtrees.md) | 保留 NewAPI、LLMGateway 和 VelaLink 的上游谱系与 pin |
| [context-governance](23-rules-matrix.md) | 变更路由、metadata、生命周期、审计或 23 条规则 contract |

## 治理资料

- [23 rules matrix](23-rules-matrix.md)
- [repository map](project/repository-map.md)
- [project overview](project/overview.md)
- [service boundaries](project/service-boundaries.md)
- [external knowledge boundaries](project/external-knowledge-boundaries.md)
- [implementation adjacency index](project/adjacency/README.md)
- [change delivery flow](flows/change-delivery.md)
- [context intake runbook](runbooks/context-intake.md)
- [Task Pack template](tasks/TASK-TEMPLATE.md)
- [Checkpoint template](tasks/CHECKPOINT-TEMPLATE.md)
- [design-history and docs-impact ADR](../engineering/decisions/ADR-0002-design-history-and-docs-impact.md)

## 硬边界

- 生成 catalog 是派生视图，绝不覆盖源码、生成的 API contract 或 manifest。
- 外部云、计费、CAM 和 API 规则通过 `.agents/context/external-sources.yaml` 链接；不得复制为仓库事实。
- 运行时 compaction、trace 收集、模型路由和自动 memory promotion 在实现并有实测证据前均为 pilot 设计。
