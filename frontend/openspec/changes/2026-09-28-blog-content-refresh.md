# Blog 入口与四篇文章更新

## 需求与范围

关联 [PRD](../../../wiki/prd-docs/2026-09-28-blog-entry-content-experience.md)。恢复国际站首页与共享 Footer 的 Blog 入口，保留国内站隐藏导流策略。活跃清单替换为用户提供的四篇文章，旧稿归档；Jasmin Zhao 的 Product 文章置顶，其余三篇为 Walker Cao 的 Use Cases。

## 最终行为

- 国内站默认中文，国际站默认英文；国际站选择简体或繁体中文时标题、摘要和全文同步切换，其他尚未翻译语言回退英文。
- 采用用户提供的新封面与正文配图；封面统一 16:9，正文图片保持原比例，图片不翻译。
- 每篇统一国际 Discord / WhatsApp 或国内微信社群结尾，试用地址去追踪参数，分享及 metadata 使用对应区域和正文语言的 canonical。
- sitemap、hreflang 和 llms.txt 只登记活跃内容，国际中文版本保留自己的语言前缀，其他退役 slug 返回 404。

## 实现与验证

更新静态首页片段及生成脚本、共享 Footer、Blog 数据和渲染组件、文章 metadata、索引规则、组件与路由测试。规格见 [blog.md](../specs/blog.md)，逐轮证据见 [任务记录](../../../docs/context/tasks/2026-09-28-blog-entry-preview.md)。

独立代码审查检查了翻译覆盖、区域分流、索引/分享一致性、归档排除和文本渲染，未发现阻塞问题。最终验证和 MR 状态写入任务 checkpoint。本变更不涉及后端、生产配置、部署或新增依赖。
