# 当前需求提案

## 背景

mono2 需要建设基于 new-api 的多 Set 架构。new-api 单 Set 能力已经足够强：它支持用户、token、subscription、channel、relay 和日志，但不负责平台级多 Set 编排。

因此需要 LLMGateway 作为外层控制面和流量适配层，把多个 new-api Set 包装成一个稳定平台协议。

## 本次 OpenSpec 的目标

这次变更不是新增运行时代码，而是把已讨论和已实现的 LLMGateway 规格沉淀为 OpenSpec：

- 明确 new-api 能满足哪些实际运营诉求；
- 明确 LLMGateway 和 new-api 的责任边界；
- 明确 subscription/权益是否足以承接平台语义；
- 明确多 Set、key 路由和 channel sync 的长期规格；
- 为后续变更提供 `proposal/design/tasks` 工作流。

## 范围

包含：

- LLMGateway 当前态；
- 面向 ctl/trade 的长期接口规格；
- new-api subscription 适配判断；
- 管理台、控制面、流量面、迁移面边界；
- 后续任务计划。

不包含：

- 修改 new-api；
- 修改 LLMGateway 运行代码；
- 提交生产发布配置；
- 引入新的审计系统；
- 复制其他系统的管理后台。

## 成功标准

- `llmgateway/openspec` 形成可读、可维护的规格入口。
- 后续新增功能可以先写 `openspec/changes/<date>-<topic>/` 再编码。
- 任何人读完 `spec.md` 和 `specs/llmgateway-dropin.md` 都能理解 LLMGateway 为什么存在、怎么分层、哪些能力已经足够、哪些仍需补齐。
