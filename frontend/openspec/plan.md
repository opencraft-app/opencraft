# 当前执行计划

> 当前需求：国内站 `/docs` 新增 LightVela 产品公告目录，并让首页公告跳转到文档页。
> 规模：M。模式：单 Agent。Figma：不涉及。

- [x] Planner/Developer: 梳理公告内容模型与 docs 接入点。
  - 影响文件：`frontend/src/content/docs/announcements/public-beta.md`、`frontend/src/config/docs-sidebar.ts`
  - 验收方式：公告全文结构覆盖用户确认内容，并在国内站 docs sidebar 出现「产品公告」目录。
- [x] Developer: 接入 Fumadocs 同步和 docs route manifest。
  - 影响文件：`frontend/scripts/sync-fumadocs-content.mjs`、`frontend/next-site/docs-route-manifest.ts`
  - 验收方式：`node frontend/scripts/sync-fumadocs-content.mjs` 后 manifest 包含 `announcements/public-beta`。
- [x] Developer: 更新首页公告条跳转，并移除旧独立公告路由。
  - 影响文件：`frontend/src/components/site/maintenance-announcement-banner.tsx`、`frontend/next-site/public-pages.tsx`、`frontend/src/app/sitemap.xml/route.next.ts`、`frontend/src/lib/public-site-routing.ts`
  - 验收方式：首页短公告详情链接指向 `/docs/announcements/public-beta`；旧 `/announcements/lightvela-public-beta` 不再作为公开入口。
- [x] Reviewer: 运行质量门禁与页面 smoke。
  - 影响文件：`frontend/src/i18n/generated/*.json`
  - 验收方式：`pnpm i18n:check`、`pnpm check`、`pnpm build:cn` 通过；本地预览验证首页入口和 docs 文章页。
