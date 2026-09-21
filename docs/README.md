# LightVela mono2 文档入口

本页是全仓导航，不是 CTL 专属目录。先按问题选择正式知识层，再进入具体服务；不要一次性加载整个 `docs/`。

## 核心入口

| 目标 | 入口 |
|---|---|
| 理解系统、领域和跨服务流程 | [Vela 工程文档](engineering/README.md) |
| 查某个服务的 Owner/依赖/入口 | [Service Catalog](engineering/catalog/services.yaml) |
| 开发具体服务 | 对应 `<service>/docs/README.md` 与最近 `AGENTS.md` |
| 维护客户产品文档 | `frontend/src/content/docs/` 与 `lv-docs` Skill |
| 查产品状态、PRD 与来源 | `wiki/` |
| 查 Agent 路由 Context | [Context 索引](context/INDEX.md)（仅按路由加载） |
| 查运行/故障入口 | [运维索引](engineering/operations/README.md) |
| 查历史方案与计划 | `docs/superpowers/`、`docs/handover/`、`docs/proposals/` |

## 按领域导航

- [身份与访问](engineering/domains/identity-access.md)
- [订阅与权益](engineering/domains/subscription-entitlements.md)
- [Agent、网关与运行时](engineering/domains/agent-gateway-runtime.md)
- [站点与环境路由](engineering/domains/site-environment-routing.md)
- [发布与 GitOps](engineering/domains/release-gitops.md)

## 已有专项资料

- CTL/Sandbox/AI Gateway 开发：[agent-guides/](agent-guides/)
- 部署说明：[deploy-guides/](deploy-guides/)
- 故障手册：[runbooks/](runbooks/)
- CTL 技术规格：[ctl-tech-specs/README.md](ctl-tech-specs/README.md)
- CTL 设计：[ctl-design/architecture.md](ctl-design/architecture.md)
- 交接材料：[handover-ctl-images.md](handover-ctl-images.md)

## 权威与治理

运行代码/测试、生成 API/Proto/Schema 和环境/GitOps Manifest 高于文案。文档落位、生命周期、生成物、vendor 和评测边界见 [文档治理规则](engineering/governance/documentation-policy.md)；架构决策见 [ADR-0001](engineering/decisions/ADR-0001-documentation-architecture.md)。
