# Vela 工程文档

这里是 mono2 的跨服务工程知识入口。它回答“系统如何组成、一个事实由谁拥有、端到端流程如何穿过多个服务、怎样验证和交付”，不替代服务代码、生成 API 契约或运行态证据。

## 按问题进入

| 你要解决的问题 | 入口 |
|---|---|
| 先理解整个系统 | [系统总览](architecture/system-overview.md) |
| 找某个服务与依赖 | [服务拓扑](architecture/service-topology.md) 与 [Service Catalog](catalog/services.yaml) |
| 判断哪个来源说了算 | [权威与机器契约](architecture/authority-and-contracts.md) |
| 理解稳定业务边界 | [领域文档](domains/) |
| 调试跨服务用户流程 | [端到端 Journey](journeys/) |
| 处理 CI、infra、GitOps 或 subtree | [平台知识](platform/README.md) |
| 找监控、故障与恢复入口 | [运维入口](operations/README.md) |
| 决定文档写在哪里 | [文档治理](governance/documentation-policy.md) |

## 五个领域

- [身份与访问](domains/identity-access.md)
- [订阅与权益](domains/subscription-entitlements.md)
- [Agent、网关与运行时](domains/agent-gateway-runtime.md)
- [站点与环境路由](domains/site-environment-routing.md)
- [发布与 GitOps](domains/release-gitops.md)

## 文档分层

```text
服务源码与机器契约       最终行为真源
<service>/docs/         与代码共置的服务知识
docs/engineering/       跨服务架构、领域、Journey、平台与运维
frontend/src/content/docs/  客户产品文档区域真源
wiki/                    产品状态、PRD 与来源
docs/context/            从上述正式知识派生的 Agent 消费层
```

先读最接近任务的一层，只有跨越边界时才上升到领域或 Journey。文档不足时优先补正式知识，再更新派生 Context；不要在 Context Pack 中创造仓库里没有依据的新事实。
