# Agent Skills Index

本目录存放仓库内团队共享的 Agent Skills。任何 coding agent 在开始任务时，推荐先查看本索引；当任务匹配某个 skill 时，再读取对应目录下的 `SKILL.md`。

| Skill | 适用场景 |
| --- | --- |
| `gongfeng` | 工蜂仓库操作、分支管理、MR 创建/查询、MR 评论、代码审查、文件操作、提交查询 |
| `devops-pipeline` | 蓝盾流水线、CI/CD、构建查询、构建启动/取消、构建状态、流水线参数修改 |
| `tencent-tat-instance-mining` | 通过腾讯云 TAT/自动化助手批量采集 Hermes CVM 实例数据，统计 Token、Session、通道配置，并可按账号表合并分析 |
| `baseline-ui` | UI 组件、Tailwind 样式、排版层级、布局反模式、前端界面一致性检查 |
| `better-icons` | 搜索、选择、替换图标，或需要从 Iconify 图标库获取 SVG |
| `fixing-accessibility` | 表单、弹窗、交互控件、键盘导航、ARIA、色彩对比度、WCAG 可访问性修复 |
| `fixing-metadata` | 页面标题、meta description、canonical、Open Graph、Twitter Card、robots、JSON-LD |
| `fixing-motion-performance` | 动画卡顿、transition 性能、scroll-linked motion、layout thrashing、blur/filter 性能问题 |
| `product-skills/prd-init` | LightVela 产品前置、PRD 梳理、TAPD 产品需求建单与研发交接 |
| `lv-international-docs` | LightVela 国际站文档维护，编辑/翻译/审查 `lightvela.ai/docs`、`global/`、`en/`、文档图片与 sidebar/slug |
| `lv-longform-content` | LightVela 长篇内容写作，生成教程系列、功能介绍系列、应用场景系列、英文博客/文章草稿 |
| `lv-seo-geo` | LightVela SEO/GEO 优化，检查关键词、sitemap、canonical/hreflang、内部链接、AI 搜索可抽取性 |

## 使用约定

- skill 内引用的 `references/`、`scripts/`、`DEPENDENCIES.md` 等资源，都以该 skill 目录为相对路径解析。
- 涉及外部系统、发布、构建、MR、分支、凭据或不可逆操作时，必须遵守对应 skill 和根 `AGENTS.md` 的确认要求。
- 新增团队共享 skill 时，放入 `.agents/skills/<skill-name>/SKILL.md`，并同步更新本索引。
