# 国际站 Blog 入口与页面头部统一 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** 实现完成，等待验收；不自动 commit、push 或创建 MR。

**Goal:** 让国际站所有公开页共享 Blog 顶部入口，并让首页与 Blog 页保持一致的国际站 Footer，同时保留 Blog 页当前透明头部效果。

**Architecture:** 在 `PUBLIC_SITE_NAV_ITEMS` 注册一个 `globalOnly` 的 Blog 导航项。
`PublicSiteHeader` 统一过滤国内站不可见项并复用现有国际化 URL 生成逻辑。
`LightVelaFooter` 继续作为 React 公共页面的 Footer 数据源，Blog 作为国际站 Product 栏第一项。
国际站新版首页通过 `import-international-homepage.mjs` 生成的静态片段同步相同导航和 Footer 入口。

**Tech Stack:** Next.js 16、React 19、TypeScript 5.9、Tailwind CSS v4、Vitest 4、Testing Library。

## Global Constraints

- Blog 顶部入口只在国际站显示。
- Blog Footer 入口只在国际站显示，并位于 Product 栏第一项。
- 国内站导航和 Footer 不得出现 Blog。
- Blog 页继续使用 `PublicSiteHeader appearance="immersive"`，不改变当前透明度。
- 不新增依赖，不修改登录、语言切换、首页 CTA、Blog 正文或 Footer 其他链接。
- 首页静态片段的 Blog 链接必须覆盖已发布国际站语言前缀。
- 所有修改必须先有失败测试，再写业务实现。
- 不执行 `git commit`、`git push` 或创建 MR。

---

### Task 1: 注册国际站 Blog 顶部导航项

**Files:**

- Modify: `frontend/src/lib/public-site-navigation.ts`
- Modify: `frontend/src/components/site/public-site-header.tsx`
- Modify: `frontend/src/lib/__tests__/public-site-navigation.test.ts`
- Modify: `frontend/src/components/site/__tests__/site-header.test.tsx`
- Create: `frontend/src/components/site/__tests__/site-header.global.test.tsx`

**Interfaces:**

- Consumes: `PUBLIC_SITE_NAV_ITEMS`、`publicSiteHref()`、`isGlobal` 和 `PublicSiteSection`。
- Produces: 国际站的公共导航包含 `Blog`，国内站继续隐藏 Blog，移动菜单和桌面菜单共享同一项。

- [x] **Step 1: 写国际站导航数据的失败测试。**

在 `public-site-navigation.test.ts` 增加以下断言：

```ts
describe("PUBLIC_SITE_NAV_ITEMS Blog entry", () => {
  it("registers Blog as an international-only public navigation entry", async () => {
    const { PUBLIC_SITE_NAV_ITEMS } = await loadPublicSiteNavigation("global");
    const blog = PUBLIC_SITE_NAV_ITEMS.find((item) => item.section === "blog");

    expect(blog).toBeDefined();
    expect(blog?.href).toBe("/blog");
    expect(blog?.globalOnly).toBe(true);
    expect(blog?.label["en-US"]).toBe("Blog");
  });
});
```

在 `site-header.test.tsx` 的国内站默认测试中增加：

```tsx
expect(screen.queryByRole("link", { name: "博客" })).not.toBeInTheDocument();
```

新建 `site-header.global.test.tsx`，固定 `@/lib/region` 的 `isGlobal: true`，并增加桌面导航和移动菜单断言：

```tsx
it("shows Blog in the desktop and mobile public navigation", () => {
  render(<PublicSiteHeader locale="en-US" currentPath="/blog" />);

  expect(screen.getByRole("link", { name: "Blog" })).toHaveAttribute("href", "/blog");

  fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
  expect(screen.getAllByRole("link", { name: "Blog" }).length).toBeGreaterThanOrEqual(2);
});
```

- [x] **Step 2: 运行失败测试。**

Run: `pnpm exec vitest run src/lib/__tests__/public-site-navigation.test.ts src/components/site/__tests__/site-header.test.tsx src/components/site/__tests__/site-header.global.test.tsx`

Expected: 新增国际站 Blog 导航断言失败，因为 `PublicSiteSection` 和公共导航数据尚未注册 Blog。

- [x] **Step 3: 最小实现公共导航数据和区域过滤。**

在 `public-site-navigation.ts` 中完成以下实现：

```ts
export type PublicSiteSection = "overview" | "pricing" | "changelog" | "blog" | "docs" | "about" | "support";

export type PublicSiteNavItem = {
  section: PublicSiteSection;
  href: string;
  label: Record<PublicSiteLocale, string>;
  cnOnly?: boolean;
  globalOnly?: boolean;
};

{
  section: "blog",
  href: "/blog",
  globalOnly: true,
  label: label({
    ...zhSimplified("博客"),
    [PUBLIC_SITE_LOCALES.ZH_HANT]: "博客",
    [PUBLIC_SITE_LOCALES.EN_US]: "Blog",
    [PUBLIC_SITE_LOCALES.ID_ID]: "Blog",
    [PUBLIC_SITE_LOCALES.ES]: "Blog",
    [PUBLIC_SITE_LOCALES.JA_JP]: "ブログ",
    [PUBLIC_SITE_LOCALES.KO_KR]: "블로그",
  }),
},
```

在 `PublicSiteHeader` 的 `navLinks` 过滤中加入 `globalOnly && !isGlobal` 规则：

```ts
PUBLIC_SITE_NAV_ITEMS
  .filter((link) => !link.globalOnly || isGlobal)
  .filter((link) => !((isGlobal || localized) && link.cnOnly && locale !== "zh-CN"))
```

- [x] **Step 4: 运行 Header 和导航测试确认通过。**

Run: `pnpm exec vitest run src/lib/__tests__/public-site-navigation.test.ts src/components/site/__tests__/site-header.test.tsx src/components/site/__tests__/site-header.global.test.tsx`

Expected: 国际站 Blog 桌面导航、移动菜单和语言路径断言通过，国内站无 Blog 断言通过。

### Task 2: 锁定国际站首页与 Blog 页 Footer 入口及透明头部回归

**Files:**

- Modify: `frontend/src/components/site/__tests__/lightvela-footer.test.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/blog-page.test.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/landing-page.integration.test.tsx`
- Modify: `frontend/scripts/import-international-homepage.mjs`
- Modify: `frontend/public/lightvela-intl-home/index-fragment*.html`
- Modify: `frontend/next-site/__tests__/international-home-page.test.tsx`

**Interfaces:**

- Consumes: `LightVelaFooter`、`LandingPageView`、`BlogPage` 和共享 `PublicSiteHeader`。
- Produces: Footer 在国际站首页和 Blog 页都包含指向 `/blog` 的 Product 第一项，Blog 页仍以 `immersive` 外观渲染。

- [x] **Step 1: 写 Footer 与 Blog 头部的回归断言。**

在 Footer 测试中明确检查国际站 Product 栏的 Blog 链接，并在 Blog 页面测试中检查 Header mock 收到 `appearance="immersive"`：

```tsx
expect(product.getAllByRole("link")[0]).toHaveAccessibleName("博客");
expect(product.getAllByRole("link")[0]).toHaveAttribute("href", "/blog");
expect(screen.getByTestId("blog-header")).toHaveAttribute("data-appearance", "immersive");
```

在首页集成测试中使用国际站 mock，断言首页组合 `LightVelaFooter` 时包含 Blog 链接：

```tsx
expect(screen.getByRole("link", { name: "博客" })).toHaveAttribute("href", "/blog");
```

- [x] **Step 2: 运行 Footer、Blog 和首页回归测试确认结果。**

Run: `pnpm exec vitest run src/components/site/__tests__/lightvela-footer.test.tsx src/pages/marketing/__tests__/blog-page.test.tsx src/pages/marketing/__tests__/landing-page.integration.test.tsx`

Expected: 新增断言至少有一条在实现前失败，失败原因必须是缺少 Blog 入口或 Blog Header 外观属性，而不是测试配置错误。

- [x] **Step 3: 只在必要处调整实现。**

保持 `LightVelaFooter` 的国际站 Blog 第一项实现，不复制第二份链接清单。

保持 `BlogPage` 的现有头部配置：

```tsx
<PublicSiteHeader
  appearance="immersive"
  position="fixed"
  renderLink={renderLink}
  renderLanguageSwitcher={renderLanguageSwitcher}
/>
```

如果测试需要辨识头部，只调整测试 mock，不改变生产头部外观或增加新动画。

- [x] **Step 4: 运行回归测试确认 Footer 和 Blog 头部约束通过。**

Run: `pnpm exec vitest run src/components/site/__tests__/lightvela-footer.test.tsx src/pages/marketing/__tests__/blog-page.test.tsx src/pages/marketing/__tests__/landing-page.integration.test.tsx`

Expected: 所有 Footer、Blog 页面和首页组合断言通过。

### Task 3: 执行质量门禁和浏览器回归

**Files:**

- Verify: `frontend/src/lib/public-site-navigation.ts`
- Verify: `frontend/src/components/site/public-site-header.tsx`
- Verify: `frontend/src/components/site/lightvela-footer.tsx`
- Verify: `frontend/src/pages/marketing/blog-page.tsx`
- Verify: `frontend/openspec/changes/2026-09-02-global-blog-navigation-design.md`

**Interfaces:**

- Consumes: Task 1 和 Task 2 的导航、Footer 与头部回归。
- Produces: 国际站和国内站均通过静态检查、定向测试、构建和桌面/移动端页面验收。

- [x] **Step 1: 运行完整定向测试。**

Run: `pnpm exec vitest run src/lib/__tests__/public-site-navigation.test.ts src/components/site/__tests__/site-header.test.tsx src/components/site/__tests__/site-header.global.test.tsx src/components/site/__tests__/lightvela-footer.test.tsx src/pages/marketing/__tests__/blog-page.test.tsx src/pages/marketing/__tests__/landing-page.integration.test.tsx`

Expected: 所有相关测试通过。

- [x] **Step 2: 运行国际化、类型和差异检查。**

Run: `pnpm i18n:check && pnpm check && git diff --check`

Expected: 国际化资源完整、类型检查无新增诊断、差异无空白错误。

- [x] **Step 3: 构建国内站和国际站。**

Run: `pnpm build:cn && pnpm build:global`

Expected: 两个构建成功，国内站不含 Blog 导航或 Footer 入口，国际站公开页面包含 Blog 入口。

- [x] **Step 4: 在浏览器中检查桌面与移动端。**

使用本地国际站预览访问 `/` 和 `/blog`。

桌面端检查顶部导航都显示 Blog，首页 Footer Product 栏显示 Blog，Blog 页头部仍透明且蓝色背景可透过。

移动端打开菜单检查 Blog 可见、可聚焦、点击后跳转到 `/blog`，并确认页面无横向溢出。

- [x] **Step 5: 汇总证据并停在用户验收点。**

记录变更文件、定向测试结果、静态检查结果、双区域构建结果和浏览器检查结果。

不执行提交、推送、合并请求或归档。

## Self-review

- Blog 顶部导航、Footer 入口、国内站隔离和透明头部均有任务覆盖。
- 生产实现只扩展公共导航项并复用现有 Footer 数据，不增加重复页面级链接。
- 测试命令均使用当前 `frontend/package.json` 中已存在的 Vitest、检查和构建脚本。
- 文档没有未解析的 TBD、TODO 或占位步骤。
