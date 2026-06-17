---
title: SEO CR 边界加固
status: done
branch: seo-615
mr: https://git.woa.com/wisp/mono2/-/merge_requests/1618
date: 2026-06-17
---

# SEO CR 边界加固

## 背景

MR !1618 为 LightVela 前端补齐了 route-level SEO title、description、keywords、OG/Twitter/canonical/robots 等 head 字段，并让国内站与国际站按 region 输出不同文案。评审阶段指出，SEO HTML 注入链路仍存在若干容易在后续迭代复发的边界风险：

- dev 中间件和运行时共用的 `seo-data.ts` 需要保持 node-safe，不能依赖 `@/` alias 或 `import.meta.env`。
- dev HTML 注入不能假设 `<meta>` / `<link>` 属性顺序固定，否则遇到反序属性会插入重复标签。
- `/agents/*` 这类动态路由不能让非法 URI 编码触发 `decodeURIComponent` 异常并导致 dev 中间件 500。
- `generate-static-site.mjs` 与 `seo-data.ts` 的镜像数据需要机器对账，避免 prerender 与 SPA/dev 输出再次漂移。

## 目标

- 加固 SEO HTML 注入工具，使 title/meta/link upsert 支持任意属性顺序，并去重重复标签。
- 为非法 `/agents/%xx` 路径提供安全 decode fallback，保证 SEO 计算不抛异常。
- 将 prerender 与运行时 SEO 数据的镜像关系固化为测试。
- 将 `index.html` 中的中文 description / keywords 改为空 fallback，避免国际站未注入场景暴露中文摘要。
- 收敛 auth 辅助页的 route title 语义，避免多个页面都显示为「登录 / Sign In」。

## 非目标

- 不重构 `generate-static-site.mjs` 为 TypeScript 或共享运行时模块。
- 不引入 HTML parser 依赖；本次仍使用小范围正则 upsert。
- 不改变现有路由结构、页面渲染或后端接口。
- 不处理 MR 中已由 reviewer 撤回的 RootLayout / AppShellLayout 嵌套误报。

## 影响范围

- `frontend/src/lib/seo-html.ts`
- `frontend/src/lib/seo-data.ts`
- `frontend/vite.config.ts`
- `frontend/index.html`
- `frontend/src/lib/__tests__/seo*.test.ts`
- `frontend/openspec/specs/marketing.md`

## 兼容性

- 对用户可见页面无破坏性变更。
- `getSeoMeta()` 仍保持 `region` 可选且默认国内站的兼容行为。
- HTML 注入输出字段名和标签语义不变，只增强 matcher、去重和 fallback。

## 质量保障

- 定向测试：`pnpm vitest run scripts/generate-static-site.test.ts src/lib/__tests__/seo*.test.ts`
- 影响面测试：`pnpm vitest run src/lib/__tests__/`
- 类型检查：`pnpm check`
- i18n 检查：`pnpm i18n:check`
- 空白检查：`git diff --check`
