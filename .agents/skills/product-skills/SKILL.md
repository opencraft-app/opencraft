---
name: lightvela-product-skills
description: 当 LightVela 相关工作需要在 PRD 初始化、SEO/GEO 审查或 Vibe Coding 研发协作流程之间选择合适 Skill 时使用。
---

# LightVela Product Skills

这是 LightVela 产品线 Skills 的聚合入口。`mono2/.agents/skills/product-skills` 是这些 Skills 的主仓目录，其他仓库中的副本只用于分发或消费。

## 可用 Skill

- `prd-init/`：把 LightVela 想法、反馈、Issue、TAPD 草稿或未完成 PRD 整理成产品输入稿、PRD 草稿、TAPD 写入计划和研发交接建议。
- `lv-seo-geo/`：审查和优化 LightVela 页面、文档或博客的搜索可见性、生成式搜索可抽取性、sitemap 一致性和内部链接。
- `lv-vibe-coding/`：指导 LightVela 从需求澄清、Issue 建单、`/feai-start` 开发到评审、MR、发布和回归验证的研发协作流程。

## 使用规则

1. 先判断任务属于产品需求前置、SEO/GEO 内容审查，还是 Vibe Coding 研发协作。
2. 产品需求、PRD、TAPD 和研发交接类工作使用 `prd-init`。
3. 搜索可见性、GEO、sitemap、内部链接和页面内容结构类工作使用 `lv-seo-geo`。
4. LightVela 需求到开发、评审、MR、发布和回归的完整协作流程使用 `lv-vibe-coding`。
5. 执行具体工作时，读取对应子目录里的 `SKILL.md`，不要只依赖本聚合入口。
