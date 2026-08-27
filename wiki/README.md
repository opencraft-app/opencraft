# LightVela Wiki

本目录是 LightVela 在 mono2 仓库内的项目协同知识区，用于同时服务产品、研发、运营和 AI agent。

## 目录结构

- `product-state/`：当前状态层，维护目标、风险和当前重点。
- `roadmap/`：产品路线图目录，维护总体规划和各阶段 Roadmap。
- `techpedia/`：技术百科长篇内容目录，维护中英文 Techpedia 文章。
- `sources/`：原始输入层，维护进展、脑暴、会议、市场分析等可回溯来源。
- `knowledge/`：沉淀知识层，维护概念、决策和长期产品理解。
- `prd-docs/`：需求文档层，存放通过 [`prd-creator`](../.agents/skills/product-skills/prd-creator/SKILL.md) 梳理生成的 PRD 需求单。

## PRD 需求单

`prd-docs/` 用于保存具体产品需求的评审与执行基线。需求仍处于想法、反馈、Issue、问题单或模糊 TAPD 单阶段时，使用 `prd-creator` 完成需求澄清、方案梳理、范围界定和验收标准整理，并将确认后的 PRD 写入：

```text
wiki/prd-docs/YYYY-MM-DD-<short-title>.md
```

`prd-docs/` 与其他目录的关系如下：

- PRD 可以引用 `sources/` 中的调研、会议、脑暴和进展记录，但 PRD 本身不是原始输入材料。
- PRD 中影响当前目标、路线、环境或风险的结论，应同步检查并更新 `product-state/`。
- PRD 中形成的长期概念、稳定决策或可复用产品理解，应进一步沉淀到 `knowledge/`。
- 需求发生变化时，应更新对应 PRD，保持同一需求的评审和执行基线一致。

## Agent 读取顺序

处理具体需求的评审、实现或交接任务时，先读取 `prd-docs/` 中对应的 PRD；处理产品策略、规划或知识整理任务时，建议按以下顺序读取：

1. `product-state/current-focus.md`
2. `product-state/environment.md`
3. `roadmap/`，根据规划周期查看对应的 Roadmap
4. `product-state/risks.md`
5. `knowledge/README.md`
6. 需要验证时再回到 `sources/` 中的原始材料。

## 维护原则

- `sources/` 保留输入材料，不直接当作当前结论。
- `knowledge/` 记录已经沉淀出的稳定理解，并尽量指回来源。
- `product-state/` 反映当前读数，过期内容应及时更新或移入来源/归档。
- `prd-docs/` 维护具体需求的已确认范围和验收标准，新增 PRD 优先使用 `prd-creator` 生成。
