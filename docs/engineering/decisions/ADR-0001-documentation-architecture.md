# ADR-0001：采用混合式工程文档架构

- 状态：accepted
- 日期：2026-08-26
- 决策 Owner：`wisp/mono2-maintainers`

## 背景

mono2 有大量一方、产品、工作、上游和生成文档，但缺少统一入口、Service Catalog、生命周期和全仓覆盖证据。已有 `docs/context/` 能路由少量 Agent Pack，却不能替代面向研发/产品/运维的正式知识体系。

## 决策

采用混合式架构：服务知识与代码共置；跨服务知识集中在 `docs/engineering/`；客户产品文档保留区域真源；工作产物显式管理生命周期；Agent Context 从正式知识派生。

## 为什么不选两个极端

全部集中会让服务文档远离代码、容易漂移；全部散在服务目录又无法表达身份、商业化、Agent runtime、双站和发布等端到端关系。混合式架构把局部 Owner 与跨域导航同时保留，并通过机器 Catalog/Validator 连接。

## 后果

- 每个主要服务必须有 `README.md`、短 `AGENTS.md`、`catalog-info.yaml`、`docs/README.md`。
- 跨服务事实只在一个 canonical 工程文档维护，Context Pack 回链并标为 derived。
- vendor/subtree、生成物、评测和 archive 进入文档地图但不按一方正文重写。
- 全仓文档覆盖与 Context 控制面分开评分，避免少量 Pack 100% 覆盖冒充仓库文档成熟。

## 验证

由 `.agents/context/scripts/validate_documentation.py` 检查服务入口、目录、层级、派生来源、分类和链接；Context Validator/Audit 继续检查路由、指令链、消费收据与评测隔离。
