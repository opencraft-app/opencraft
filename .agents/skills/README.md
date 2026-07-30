# Agent Skills Index

本目录存放仓库内团队共享的 Agent Skills。任何 coding agent 在开始任务时，推荐先查看本索引；当任务匹配某个 skill 时，再读取对应目录下的 `SKILL.md`。

| Skill | 适用场景 |
| --- | --- |
| `codedog-lint-fix` | 智研 CodeDog / CodeLint 问题获取、筛选、分析、修复、验证与 MR 交付 |
| `gongfeng` | 工蜂仓库操作、分支管理、MR 创建/查询、MR 评论、代码审查、文件操作、提交查询 |
| `devops-pipeline` | 蓝盾流水线、CI/CD、构建查询、构建启动/取消、构建状态、流水线参数修改 |
| `tencent-tat-instance-mining` | 通过腾讯云 TAT/自动化助手批量采集 Hermes CVM 实例数据，统计 Token、Session、通道配置，并可按账号表合并分析 |
| `baseline-ui` | UI 组件、Tailwind 样式、排版层级、布局反模式、前端界面一致性检查 |
| `better-icons` | 搜索、选择、替换图标，或需要从 Iconify 图标库获取 SVG |
| `fixing-accessibility` | 表单、弹窗、交互控件、键盘导航、ARIA、色彩对比度、WCAG 可访问性修复 |
| `fixing-metadata` | 页面标题、meta description、canonical、Open Graph、Twitter Card、robots、JSON-LD |
| `fixing-motion-performance` | 动画卡顿、transition 性能、scroll-linked motion、layout thrashing、blur/filter 性能问题 |
| `product-skills` | LightVela 产品线 Skills 聚合入口与 mono2 主仓目录 |
| `product-skills/prd-creator` | LightVela 产品前置、PRD 梳理、TAPD 产品需求建单与产物交接 |
| `product-skills/lv-seo-geo` | LightVela SEO/GEO 优化，检查关键词、sitemap、canonical/hreflang、内部链接、AI 搜索可抽取性 |
| `product-skills/lv-vibe-coding` | LightVela 从需求澄清、Issue、开发、评审、MR 到发布回归的 Vibe Coding 协作流程 |
| `product-skills/lightvela-changelog-update` | LightVela 产品动态与更新日志流程，包括需求阶段判断、动态草稿、素材准备、AutoSync 和 changelog 展示 |
| `product-skills/lv-international-docs` | LightVela 国际站文档维护，编辑/翻译/审查 `lightvela.ai/docs`、`global/`、`en/`、文档图片与 sidebar/slug |
| `product-skills/lv-longform-content` | LightVela 长篇内容写作，生成教程系列、功能介绍系列、应用场景系列、英文博客/文章草稿 |
| `product-skills/lv-sitepage-skills` | 维护国内站和国际站 Agent Skills 的 Discover 分类、Featured 精选、搜索、来源、My Skills、Create Skill 和分页规范 |

## 使用约定

- skill 内引用的 `references/`、`scripts/`、`DEPENDENCIES.md` 等资源，都以该 skill 目录为相对路径解析。
- 涉及外部系统、发布、构建、MR、分支、凭据或不可逆操作时，必须遵守对应 skill 和根 `AGENTS.md` 的确认要求。
- 新增 LightVela 产品 Skill 时，放入 `.agents/skills/product-skills/<skill-name>/SKILL.md`；其他团队共享 Skill 放入 `.agents/skills/<skill-name>/SKILL.md`，并同步更新本索引。
