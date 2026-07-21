# LightVela Wiki

本目录是 LightVela 在 mono2 仓库内的项目协同知识区，用于同时服务产品、研发、运营和 AI agent。

## 目录结构

- `product-state/`：当前状态层，维护目标、路线图、风险和当前重点。
- `sources/`：原始输入层，维护进展、脑暴、会议材料等可回溯来源。
- `knowledge/`：沉淀知识层，维护概念、决策和长期产品理解。

## Agent 读取顺序

处理产品策略、规划或知识整理任务时，建议按以下顺序读取：

1. `product-state/current-focus.md`
2. `product-state/roadmap.md`
3. `product-state/risks.md`
4. `knowledge/README.md`
5. 需要验证时再回到 `sources/` 中的原始材料。

## 维护原则

- `sources/` 保留输入材料，不直接当作当前结论。
- `knowledge/` 记录已经沉淀出的稳定理解，并尽量指回来源。
- `product-state/` 反映当前读数，过期内容应及时更新或移入来源/归档。
