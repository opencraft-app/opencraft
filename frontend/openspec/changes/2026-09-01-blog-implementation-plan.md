# LightVela Blog 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `test-driven-development` before implementation and `verification-before-completion` before claiming completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 LightVela 国际站提供无内容的多语言 Blog 页面、分类切换和首页页脚入口。

**Architecture:** Blog 复用公开站的 Next App Router 路由、Header、Footer 和 locale bridge。
页面主体维护当前分类并展示静态文章数据，文章正文由独立文章组件渲染。
默认和带语言前缀的 Next 路由分别复用同一个公开页面包装器，并沿用现有 Changelog 的 metadata 和静态导出模式。

**Tech Stack:** Next.js 16 App Router、React 19、TypeScript 5.9、Tailwind CSS v4、Vitest 4、Testing Library。

## 全局约束

- Blog 只在国际站显式入口，默认路由为 `https://lightvela.ai/blog`。
- 已发布国际站 locale 都必须生成 `/[lang]/blog` 与 `/[lang]/blog/[slug]` 静态路由，文章内容保持英文且不随语言切换。
- Header、Footer、SEO metadata 和分类标签使用现有多语言机制。
- 分类仍仅使用文字、深色选中态和细下划线表达，不增加胶囊、描边、阴影或装饰形状。
- Blog 列表使用桌面端三列卡片布局，卡片只展示轻微圆角封面、标题与 `Category · Date`，不展示摘要。
- 不新增依赖，不改变 Header 主导航，也不在国内站页脚添加 Blog 入口。
- 所有用户可见中文经 `useT()` 抽取，并补齐六种必填翻译。
- 每个 commit、push 或 MR 创建前必须展示内容并取得用户确认。

---

### Task 1: 注册 Blog 公开路径并添加国际站页脚入口

**Files:**

- Modify: `src/lib/public-site-routing.ts`
- Modify: `src/components/site/lightvela-footer.tsx`
- Modify: `src/components/site/__tests__/lightvela-footer.test.tsx`
- Modify: `src/lib/__tests__/public-site-navigation.test.ts`

**Interfaces:**

- Consumes: `PUBLIC_LOCALIZED_PATH_PREFIXES`、`localizedPath()`、`isGlobal` 与 `FooterLink`。
- Produces: `localizedPath('/blog', locale)` 能返回当前国际站语言的 Blog URL，且 `Product` 链的第一项在国际站是 Blog。

- [ ] **Step 1: 写出路径和页脚的失败测试。**

```ts
expect(publicSiteHref('/blog', 'zh-CN', { localized: true })).toBe('/zh-sg/blog');
expect(screen.getByRole('link', { name: 'Blog' })).toHaveAttribute('href', '/blog');
```

- [ ] **Step 2: 运行目标测试并确认当前失败。**

Run: `pnpm vitest run src/components/site/__tests__/lightvela-footer.test.tsx src/lib/__tests__/public-site-navigation.test.ts`

Expected: Blog 尚未出现在国际站 Product 栏，且 `/blog` 尚未列为可本地化公开路径。

- [ ] **Step 3: 以最小改动注册路径和链接。**

```ts
export const PUBLIC_LOCALIZED_PATH_PREFIXES = [
  '/docs',
  '/blog',
] as const;

links: [
  ...(isGlobal ? [{ label: t('博客'), to: '/blog' } satisfies FooterLink] : []),
  { label: t('14 天免费试用'), to: SUBSCRIBE_PATH },
]
```

- [ ] **Step 4: 再次运行目标测试并确认通过。**

Run: `pnpm vitest run src/components/site/__tests__/lightvela-footer.test.tsx src/lib/__tests__/public-site-navigation.test.ts`

Expected: 所有目标用例通过，国内站断言确认无 Blog 链接。

- [ ] **Step 5: 在用户确认后提交本任务。**

```bash
git add src/lib/public-site-routing.ts src/components/site/lightvela-footer.tsx src/components/site/__tests__/lightvela-footer.test.tsx src/lib/__tests__/public-site-navigation.test.ts
git commit -m "新增国际站 Blog 页脚入口 / feat(frontend): add global Blog footer entry"
```

### Task 2: 实现极简 Blog 主体和分类切换

**Files:**

- Create: `src/pages/marketing/blog-page.tsx`
- Create: `src/pages/marketing/__tests__/blog-page.test.tsx`
- Modify: `src/i18n/generated/zh-CN.json`
- Modify: `src/i18n/generated/en-US.json`
- Modify: `src/i18n/generated/zh-Hant.json`
- Modify: `src/i18n/generated/id-ID.json`
- Modify: `src/i18n/generated/es.json`
- Modify: `src/i18n/generated/ja-JP.json`
- Modify: `src/i18n/generated/ko-KR.json`
- Modify: `src/i18n/generated/zh-to-key.json`

**Interfaces:**

- Consumes: `PublicSiteHeader`、`LegalFooter`、`LightVelaFooter`、`useT()`、`PublicSiteLocale` 与 `RenderPublicSiteHeaderLink`。
- Produces: `BlogPage`，接收与 `ChangelogPage` 相同的 Header 适配参数，内部维护 `BlogCategory = 'all' | 'announcement' | 'product' | 'use-cases'`。

- [ ] **Step 1: 写出分类交互和简洁视觉规则的失败测试。**

```tsx
render(<BlogPage publicLocale="en-US" />);
expect(screen.getByRole('heading', { name: 'Blog' })).toBeInTheDocument();
const product = screen.getByRole('button', { name: 'Product' });
await user.click(product);
expect(product).toHaveAttribute('aria-pressed', 'true');
expect(screen.getByRole('status')).toHaveTextContent('No Product posts yet.');
expect(product.className).not.toMatch(/rounded|border|shadow/);
```

- [ ] **Step 2: 运行目标测试并确认当前失败。**

Run: `pnpm vitest run src/pages/marketing/__tests__/blog-page.test.tsx`

Expected: `BlogPage` 尚不存在。

- [ ] **Step 3: 实现单一职责的展示组件。**

```tsx
type BlogCategory = 'all' | 'announcement' | 'product' | 'use-cases';

const categories: readonly BlogCategory[] = ['all', 'announcement', 'product', 'use-cases'];

const [activeCategory, setActiveCategory] = useState<BlogCategory>('all');

<button
  aria-pressed={activeCategory === category}
  className={cn(
    'pb-1 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-black',
    activeCategory === category ? 'text-black' : 'text-black/45 hover:text-black',
  )}
  onClick={() => setActiveCategory(category)}
  type="button"
>
  {labelFor(category)}
  {activeCategory === category && <span aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-black" />}
</button>
```

页面容器只使用白色背景、居中 `max-w`、响应式 padding 和文字间距。
文章列表不渲染空状态、占位图或空列表边框。

- [ ] **Step 4: 抽取并填写界面翻译。**

Run: `pnpm i18n:extract`

为“博客”“全部”“公告”“产品”“使用场景”补齐 English、繁中、印尼语、西语、日语和韩语翻译。

- [ ] **Step 5: 运行页面和国际化检查。**

Run: `pnpm vitest run src/pages/marketing/__tests__/blog-page.test.tsx && pnpm i18n:check`

Expected: 所有 Blog 交互断言通过，翻译缺失为 0。

- [ ] **Step 6: 在用户确认后提交本任务。**

```bash
git add src/pages/marketing/blog-page.tsx src/pages/marketing/__tests__/blog-page.test.tsx src/i18n/generated
git commit -m "新增极简 Blog 分类页 / feat(frontend): add Blog category page"
```

### Task 3: 接入公开路由、各语言 metadata 与索引

**Files:**

- Modify: `next-site/public-pages.tsx`
- Create: `src/app/(site)/blog/page.next.tsx`
- Create: `src/app/(site)/[lang]/blog/page.intl.tsx`
- Create: `src/app/(site)/blog/page.next.test.tsx`
- Modify: `next-site/seo.test.ts`
- Modify: `src/lib/seo-data.ts`
- Modify: `src/lib/__tests__/seo.test.ts`
- Modify: `src/lib/__tests__/seo-data.page-description.test.ts`
- Modify: `src/lib/seo-data.ja.ts`
- Modify: `src/lib/seo-data.ko.ts`
- Modify: `src/app/sitemap.xml/route.next.ts`
- Modify: `src/app/sitemap.xml/__tests__/sitemap-route.test.ts`
- Modify: `src/app/llms.txt/route.next.ts`
- Create: `src/app/llms.txt/__tests__/llms-route.test.ts`

**Interfaces:**

- Consumes: `PublicSiteLocaleBridge`、`PublicHeaderAuthIsland`、`renderNextPublicSiteHeaderLink`、`renderNextLanguageSwitcher`、`prefixedPublicRouteLocale()`、`SEO_PREFIXED_PUBLIC_URL_LANGS` 与 `createPublicMetadata()`。
- Produces: `PublicBlogPage`，其 props 与 `PublicChangelogPage` 一致，并由 `/blog` 和 `/[lang]/blog` 共用。

- [ ] **Step 1: 写出静态路由和 metadata 的失败测试。**

```ts
const page = await import('../src/app/(site)/[lang]/blog/page.intl');
expect(await page.generateStaticParams()).toContainEqual({ lang: 'es' });
expect((await page.generateMetadata({ params: Promise.resolve({ lang: 'es' }) })).title).toContain('Blog');
expect(getSeoMeta('/blog', 'global').description).not.toBe(getSeoMeta('/', 'global').description);
```

同时扩展 sitemap 和 `llms.txt` 的测试或同源路由校验，断言国际站包含 `/blog`。

- [ ] **Step 2: 运行目标路由测试并确认当前失败。**

Run: `pnpm vitest run next-site/seo.test.ts src/app/(site)/blog/page.next.test.tsx src/app/sitemap.xml/__tests__/sitemap-route.test.ts src/app/llms.txt/__tests__/llms-route.test.ts src/lib/__tests__/seo.test.ts src/lib/__tests__/seo-data.page-description.test.ts`

Expected: Blog Next 页面和国际化 metadata 尚不存在。

- [ ] **Step 3: 按 Changelog 模式实现路由包装与 metadata。**

```tsx
export function PublicBlogPage({
  locale = DEFAULT_PUBLIC_ROUTE_LOCALE.locale,
  localized = DEFAULT_PUBLIC_ROUTE_LOCALE.localized,
}: Partial<PublicRouteLocale> = {}) {
  const pathname = usePathname() || '/blog';
  return (
    <PublicSiteLocaleBridge locale={locale}>
      <BlogPage
        authControls={<PublicHeaderAuthIsland locale={locale} />}
        currentPath={pathname}
        publicLocale={locale}
        publicLocalized={localized}
        renderLink={renderNextPublicSiteHeaderLink}
        renderLanguageSwitcher={renderNextLanguageSwitcher}
      />
    </PublicSiteLocaleBridge>
  );
}
```

默认路由 metadata 使用 `/blog` 和英文 Blog title/description。
本地化路由像 Changelog 一样列全语言 title/description，并将日语和韩语强类型路径表扩展为 `/blog`。
默认与带前缀路由均在 `isGlobal === false` 时调用 `notFound()`，避免国内产物产生可访问的 Blog 页面。

- [ ] **Step 4: 将 Blog 加入可发现性产物。**

```ts
const publicPaths = ['/', '/about', '/blog', '/changelog'];

entries: [
  { title: 'Home', path: '/' },
  { title: 'About', path: '/about' },
  { title: 'Blog', path: '/blog' },
  { title: 'Changelog', path: '/changelog' },
]
```

国内 `llms.txt` 和 sitemap 不新增 Blog 项，国际站分支才输出 Blog。

- [ ] **Step 5: 运行公开路由与 SEO 回归。**

Run: `pnpm vitest run next-site/seo.test.ts && pnpm check`

Expected: 默认和语言前缀 Blog 路由都在静态参数与 metadata 断言中通过，类型检查无新增诊断。

- [ ] **Step 6: 在用户确认后提交本任务。**

```bash
git add next-site/public-pages.tsx 'src/app/(site)/blog/page.next.tsx' 'src/app/(site)/[lang]/blog/page.intl.tsx' 'src/app/(site)/blog/page.next.test.tsx' next-site/seo.test.ts src/lib/seo-data.ts src/lib/__tests__/seo.test.ts src/lib/__tests__/seo-data.page-description.test.ts src/lib/seo-data.ja.ts src/lib/seo-data.ko.ts src/app/sitemap.xml/route.next.ts src/app/sitemap.xml/__tests__/sitemap-route.test.ts src/app/llms.txt/route.next.ts src/app/llms.txt/__tests__/llms-route.test.ts
git commit -m "接入多语言 Blog 路由与 SEO / feat(frontend): publish localized Blog routes"
```

### Task 4: 执行全量质量门禁和浏览器验收

**Files:**

- Verify: `openspec/specs/blog.md`
- Verify: `openspec/changes/2026-09-01-blog-implementation-plan.md`

**Interfaces:**

- Consumes: 已完成的 Blog 页面、公开路由、Footer 链接和静态构建产物。
- Produces: 可复核的质量结果与浏览器验收证据。

- [ ] **Step 1: 运行定向组件、Footer 与 SEO 测试。**

Run: `pnpm vitest run src/pages/marketing/__tests__/blog-page.test.tsx src/components/site/__tests__/lightvela-footer.test.tsx next-site/seo.test.ts`

Expected: 全部通过。

- [ ] **Step 2: 执行国际化、类型与差异门禁。**

Run: `pnpm i18n:check && pnpm check && git diff --check`

Expected: 翻译缺失为 0、无新增 TypeScript diagnostics、无空白错误。

- [ ] **Step 3: 构建国内站和国际站静态产物。**

Run: `pnpm build:cn && pnpm build:global`

Expected: 两个构建均成功，国际站产物包含 `/blog` 和所有已发布语言的 Blog 路径，国内站不显示 Footer Blog 链接。

- [ ] **Step 4: 进行桌面与移动端浏览器验收。**

在国际站构建或本地预览中访问 `/blog`、`/zh-sg/blog` 和 `/ja/blog`。
分别在桌面与 390px 宽度下确认 Header 与 Footer 对齐、标题居中、分类仅呈现文字和细下划线、键盘聚焦可见、分类切换不跳页、空状态随界面语言变化且没有横向溢出。

- [ ] **Step 5: 在用户确认后提交验证与 OpenSpec 产物。**

```bash
git add openspec/specs/blog.md openspec/changes/2026-09-01-blog-implementation-plan.md
git commit -m "补充 Blog 页面规格与验证 / docs(frontend): document Blog page"
```

## 自检

- 设计中的所有范围均有任务覆盖：多语言路由与 metadata 在 Task 3，Footer 入口在 Task 1，极简分类交互与空状态在 Task 2，构建和浏览器验收在 Task 4。
- 计划不包含文章数据、文章卡片、额外 Header 导航项或新增依赖。
- `BlogCategory`、`PublicBlogPage` 和路由文件名在所有任务中保持一致。

### Task 5: 统一文章宽度、封面与分享结尾

**Role:** Developer

**Files:**

- Create: `src/pages/marketing/blog-share-actions.tsx`
- Create: `src/pages/marketing/__tests__/blog-share-actions.test.tsx`
- Modify: `src/pages/marketing/blog-article-page.tsx`
- Modify: `src/pages/marketing/__tests__/blog-article-page.test.tsx`
- Create: `.agents/skills/product-skills/lv-blog-publishing/SKILL.md`

**Acceptance:**

- [x] 文章内容区与 Blog 三列列表共用 `max-w-5xl` 总宽度。
- [x] 文章封面固定为轻微圆角的 16:9 `object-cover`，正文图片保持原始比例，窄图继续受 `size: "narrow"` 控制。
- [x] 所有文章正文后复用同一分享结尾：细分隔线、Share、Copy link、X、LinkedIn、Facebook。
- [x] Copy link 复制 `https://lightvela.ai` 的当前文章公开路径，分享链接带文章标题和链接。
- [x] 新增 Blog 发布 Skill，在缺少语言或分类时询问，并在缺少用户提供的封面时要求上传；Skill 规定内容格式、16:9 裁剪、统一分享结尾及实际上传时间。
- [x] 定向 Vitest、`pnpm i18n:check`、`pnpm check`、`pnpm build:global` 与 `git diff --check` 均通过。
