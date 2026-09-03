---
id: project-overview
type: project
scope: LightVela mono2 的项目级架构、模块关系、关键数据边界与当前有效决策的短路由。
triggers: ["project overview", "system architecture", "模块关系", "项目架构", "数据模型"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - docs/engineering/architecture/system-overview.md
  - docs/engineering/architecture/service-topology.md
  - docs/engineering/architecture/authority-and-contracts.md
  - docs/engineering/catalog/services.yaml
  - docs/engineering/decisions/
status: active
reviewed_at: 2026-09-01
review_due: 2026-11-30
revision: 1.0.0
precedence: project
derived: true
architecture_refs: ["docs/engineering/architecture/system-overview.md", "docs/engineering/architecture/service-topology.md"]
module_relationships: ["产品表面 → 公共网关 → 业务状态/控制面 → Agent runtime", "源码 master → .ci 制品 → argocd 期望状态 → 运行态验证"]
data_model_refs: ["docs/engineering/domains/identity-access.md", "docs/engineering/domains/subscription-entitlements.md"]
key_flows: ["docs/engineering/journeys/account-to-agent.md", "docs/engineering/journeys/subscription-purchase-renewal.md", "docs/engineering/journeys/source-to-production.md"]
special_rules: ["运行时源码与测试、生成契约、环境 Manifest 高于工程文档和派生 Context", "国内/国际站、代码/GitOps/运行态均是独立边界"]
pitfalls: ["前端状态不是授权事实", "直连服务成功不等于公共路径成功", "评测层不得进入运行时路由"]
decision_refs: ["docs/context/decisions/ADR-0001-context-engineering-v2.md", "docs/engineering/decisions/ADR-0001-documentation-architecture.md", "docs/engineering/decisions/ADR-0002-design-history-and-docs-impact.md"]
---

# 项目级 Context：LightVela mono2

这是按需加载的短路由，不是默认注入的架构全文。只有任务涉及系统边界、跨服务关系、核心数据归属或当前设计决策时才读取；其他任务从根入口路由到更小的 Domain 或服务卡。

## 身份与边界

LightVela 是多语言 monorepo：产品表面、公共网关、身份与商业化、控制与 Agent runtime、交付平台分别有独立责任。完整结构见[系统总览](../../engineering/architecture/system-overview.md)和[服务拓扑](../../engineering/architecture/service-topology.md)。

## 必须保持的关系

- 产品 UI 与 Dashboard 不拥有授权、支付或实名事实；对应状态回到后端服务和生成契约核对。
- `user/auth`/`shadow` 拥有身份，`payment`/`subscription`/`trade` 分段拥有商业化状态；跨域约束回到对应 Domain 与 Journey。
- 源码合入、制品构建、GitOps 更新、Argo 收敛、真实业务验证是不同证据层，不能互相替代。

## 任务路由

1. 先读本页列出的正式来源，不用本页代替源码、测试、OpenAPI、Proto 或 Manifest。
2. 命中单一业务边界时改读对应 `docs/context/domains/` 卡；命中具体服务时再读 `project/services/` 卡和服务局部入口。
3. 涉及旧设计时，从[设计历史治理 ADR](../../engineering/decisions/ADR-0002-design-history-and-docs-impact.md)按受影响路径和需求标识有界恢复；未能读取的 Git、MR、TAPD、Issue 只记为未知。

## 失效与回链

Service Catalog、架构边界、当前 ADR 或关键 Journey 变化时，先更新正式真源，再更新本页和 `source-map.yaml`；设计历史不得复制到本页。
