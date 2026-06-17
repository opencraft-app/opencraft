---
title: SEO CR 边界加固设计
status: done
date: 2026-06-17
---

# SEO CR 边界加固设计

## 技术方案

### HTML head upsert

`frontend/src/lib/seo-html.ts` 继续承担 dev server SSR / transformIndexHtml 的 head 注入逻辑。本次将单一顺序假设：

```html
<meta name="description" content="...">
```

改为按 tag 起点 + 属性正向预查匹配：

```ts
<meta\b(?=[^>]*\bname\s*=\s*["']description["'])[^>]*>
```

这样能够覆盖：

- `name` 在 `content` 前或后。
- 属性名前后存在合法空格。
- 标签上存在额外属性。

命中多个相同标签时，`upsertHeadTag()` 保留第一条并替换为规范输出，移除后续重复项，避免爬虫在多条 description / canonical / OG 标签之间取值不一致。

### URI decode 防护

`getAgentsPageTitle()` 中的 `decodeURIComponent()` 包装为 `safeDecodeURIComponent()`。非法编码时返回原始 segment，让映射自然 miss 并回退到 `Agent 控制台 / Agent Console`，而不是向上抛出 `URIError`。

### dev 静态资源判断

`vite.config.ts` 的 SEO 中间件不再用 `path.extname(url)` 粗略跳过所有带点路径，而是用静态资源后缀白名单。这样未来 `/docs/v1.2.3` 这类 SPA 路由不会因为路径含点而失去 SEO 注入。

### prerender 镜像对账

`seo-site-mirror.test.ts` 从 `generate-static-site.mjs` 读取 `resolveStaticRoutes()`，并与 `getSeoMeta()` 对比：

- about / changelog 等基础 route title。
- docs route title。
- SITE / SITE_KEYWORDS 站点常量。

这样下次修改 docs 或站点文案时，如果只改 prerender 或只改运行时数据，测试会直接失败。

## 数据与文案规则

- `index.html` 的 description / keywords 留空，由 dev/prerender/运行时注入正确 region 文案。
- auth 辅助页 title 使用更准确的页面语义：
  - `/auth/sign-up-code`：`输入验证码 / Verify Code`
  - `/auth/forgot-password`：`找回密码 / Forgot Password`

## 风险与回滚

- 主要风险在 HTML 正则 matcher；已用反序属性、属性空格、重复标签三类用例覆盖。
- 如出现 dev HTML 注入异常，可优先回滚 `seo-html.ts` matcher 变更，保留 `safeDecodeURIComponent()` 与 mirror 测试。
- 未引入新依赖，回滚成本低。
