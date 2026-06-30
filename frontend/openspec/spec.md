# 当前技术规格

## 方案概述

使用项目现有文档系统实现公告页：

- 公告正文放在 `frontend/src/content/docs/announcements/public-beta.md`，由 Fumadocs 同步脚本生成文档页。
- 国内站 docs sidebar 新增「产品公告」目录，包含「公测计划及付费版本预告」。
- `frontend/scripts/sync-fumadocs-content.mjs` 生成 `announcements` 目录 meta 和 docs route manifest。
- 首页顶部 `MaintenanceAnnouncementBanner` 更新为公测公告短提示，详情链接指向 `/docs/announcements/public-beta`。
- sitemap 通过 docs route manifest 自动包含新文档页；不再新增独立 `/announcements` 公开路由。

## 内容模型

公告内容以 docs Markdown 维护，原因：

- 公告属于产品公告/文档内容，适合进入 `/docs` 信息架构。
- 复用现有 Fumadocs 内容同步、metadata 和 sitemap 能力。
- 未来新增公告时，只需要在 `src/content/docs/announcements/` 增加文档并更新目录配置。

首版只在国内站 docs sidebar 暴露，国际站不新增公告入口。

## UI 约束

- 公告在 docs 正文中按普通文章呈现，不做活动页式大首屏、事实卡片、能力卡片或路线图卡片。
- 价格表使用 Markdown 表格，文案保持紧凑，降低套餐说明在桌面端换行概率。
- 首页顶部公告条使用原生 `<a>` 与 `<button>`，icon-only close 按钮保留 `aria-label`。

## SEO 约束

- 公告文档是公开可分享页面，默认 index/follow。
- metadata title: `LightVela 公测计划及付费版本预告`
- description 聚焦 2026 年 7 月 15 日公测、内测延期、付费版本与新用户权益。
- docs route manifest 增加 `/docs/announcements/public-beta`。
- sitemap 通过 docs manifest 生成新文档 URL；独立 publicPaths 不包含 `/announcements`。

## 验证计划

- 运行 `node frontend/scripts/sync-fumadocs-content.mjs` 同步 docs 内容和 route manifest。
- 运行 `cd frontend && pnpm i18n:check`。
- 运行 `cd frontend && pnpm check`。
- 运行 `cd frontend && pnpm build:cn`。
- 启动 `pnpm dev:cn` 后 smoke：
  - `/` 首页顶部公告可见、跳转正确、关闭可用；
  - `/docs/announcements/public-beta` 呈现为 docs 文章页，左侧目录出现「产品公告」，正文包含公告内容和套餐表。
